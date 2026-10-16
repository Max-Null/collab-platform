/*
 * 活点地图的状态叠加层。
 *
 * 图本身画的是**设计上的链路**（谁在什么时候把东西交给谁）；这一层叠上去的是
 * **每一步的真实状态** —— 哪一步在失败、哪一步在等人。两者缺一不可：
 * 只有设计，看不出「现在断在哪」；只有状态，看不出「它本来该往哪走」。
 *
 * 状态的来源有两条，同一份文件都支持：
 * - **从控制台打开**（`/diagram`）：fetch `/api/overview`，看的是**此刻**。
 * - **双击打开**（`file://`）：用生成时**烤进去**的那份 `window.__LIVE_STATE__`，
 *   看的是**那一刻的快照** —— 页面上会写明快照时刻，不让人误当成现在。
 *
 * 它由 `scripts/make-live-diagram.mjs` 注入进 archify 产出的 HTML。
 * 节点的 DOM 契约来自 archify：每个节点是 `<g data-node-id="poll">`，里面有 `<rect>` 给出位置尺寸。
 *
 * ⚠️ **两种来源都得说清自己是哪一种。** 一张没有任何标记的图与一张「一切正常」的图
 * 长得一模一样；一份看不出时刻的快照与「此刻」也长得一模一样 —— 这两件事正是这个项目一直在防的。
 */
(() => {
  const NS = 'http://www.w3.org/2000/svg';

  const style = document.createElement('style');
  style.textContent = [
    // ── 应用条：三个页面共用的一条 ──
    '.live-appbar{position:fixed;left:0;right:0;top:0;z-index:100;display:flex;gap:2px;align-items:center;',
    'padding:0 18px;height:46px;background:rgba(255,255,255,.94);',
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
    'border-bottom:1px solid #e8e8e8;font:13px/1 system-ui,-apple-system,sans-serif}',
    '.live-brand{font-weight:650;color:#1a1a1a;text-decoration:none;margin-right:16px;font-size:14px}',
    '.live-nav{color:#5a5a5a;text-decoration:none;padding:6px 12px;border-radius:7px}',
    '.live-nav:hover{background:#f0f0f0;color:#111}',
    '.live-nav-here{color:#111;background:#ececec;font-weight:600}',
    // archify 自己的工具栏也是顶栏，会跟应用条抢位置（露出一块白）。
    // 把它压到应用条下面 —— 它的功能（主题/预设/导出）都还在，只是让位。
    '.toolbar,[role="toolbar"]{top:54px !important}',
    // 状态横幅再让一层，免得与工具栏在同一行上撞
    '.live-banner{position:fixed;left:50%;transform:translateX(-50%);top:106px;z-index:99;',
    'max-width:min(780px,92vw);padding:9px 16px;border-radius:9px;font:13px/1.6 system-ui,sans-serif;',
    'box-shadow:0 6px 22px rgba(0,0,0,.13);background:#fff;color:#222;border:1px solid #e3e3e3}',
    '.live-banner b{font-weight:650}',
    '.live-banner-warn{border-color:#f0c98a;background:#fff8ec}',
    '.live-banner-bad{border-color:#eea9ab;background:#fff2f2}',
    '.live-banner-snap{border-color:#c9c9d4;background:#f7f7fa}',
    '.live-badge{stroke:#fff;stroke-width:1.6;transition:r .12s ease,filter .12s ease}',
    // 可点的那些要**看得出来能点**：光有个 cursor:pointer 没用，人不会去试一个不像按钮的东西。
    // 做法是描粗白边（像按钮）+ hover 放大。
    // ⚠️ **不加箭头图标**：试过在徽标旁边放一个 ↗，在整张图里又小又碎，看着像掉了个字符。
    // 图上的出口是次要入口（横幅里那几行才是第一眼看到的地方），不必再去抢注意力。
    '.live-jumpable{cursor:pointer}',
    // 有出口的徽标描一圈更粗的白边 —— 看起来像一颗按钮，而不是图上掉的一个点
    '.live-jumpable .live-badge{stroke-width:2.4}',
    '.live-jumpable:hover .live-badge{r:9;filter:drop-shadow(0 0 5px rgba(0,0,0,.4))}',
    '.live-banner a{color:inherit;text-decoration:none;border-bottom:1px dashed currentColor}',
    '.live-badge-bad{fill:#e5484d}',
    '.live-badge-warn{fill:#f5a524}',
    '.live-pulse{animation:livePulse 1.9s ease-in-out infinite}',
    '@keyframes livePulse{0%,100%{opacity:1}50%{opacity:.42}}',
  ].join('');
  document.head.appendChild(style);

  /**
   * 应用条 —— 三个页面共用的一条：「我在哪、能去哪、怎么回去」。
   *
   * 为什么要有它：图和控制台原本是两套完全不同的壳（控制台是锚点导航，图是
   * archify 的工具栏），**两边的品牌名甚至不一样**（「协作平台」/「collab-platform」），
   * 而图上没有任何回控制台的入口 —— 唯一那个「回控制台」的链接，藏在
   * **拉不到状态时的报错弹窗**里。也就是说：只有控制台坏掉的时候，才回得去。
   *
   * 注入而不是改 archify 的产物：源图始终是「纯粹的设计图」，重新生成后重跑一次
   * `diagram:live` / `diagram:map` 即可。
   */
  function appbar() {
    const here =
      location.pathname.indexOf('/map') === 0
        ? 'map'
        : location.pathname.indexOf('/diagram') === 0
          ? 'diagram'
          : 'console';
    const item = (href, label, key) =>
      key === here
        ? '<span class="live-nav live-nav-here">' + label + '</span>'
        : '<a class="live-nav" href="' + href + '">' + label + '</a>';

    const el = document.createElement('div');
    el.className = 'live-appbar';
    el.innerHTML =
      '<a class="live-brand" href="/">协作平台</a>' +
      item('/', '控制台', 'console') +
      item('/diagram', '链路图', 'diagram') +
      item('/map', '母机地图', 'map');
    document.body.appendChild(el);
    return el;
  }

  /** 顶部那条 */
  function banner(html, level) {
    const el = document.createElement('div');
    el.className = 'live-banner live-banner-' + level;
    el.innerHTML = html;
    document.body.appendChild(el);
    // 横幅是 fixed 的，会压住标题。让它多少位置**要量、不要猜**：
    // 列出几处就有几行，写死一个值迟早会压住标题或者留一大块空白。
    // 加上 offsetTop 是因为它现在排在应用条下面（应用条也是 fixed 的）。
    document.body.style.paddingTop = el.offsetTop + el.offsetHeight + 20 + 'px';
    return el;
  }

  // 双击打开（file://）时跳不回控制台 —— 那里根本没有控制台。
  // 与其给一个点了没反应的链接，不如不给：**假出口比没有出口更坏。**
  const hookable = () => location.protocol !== 'file:';

  /**
   * 与 `console.html` 里那个同名同义。
   *
   * ⚠️ 两处各写一份是没办法的事（一个是注入脚本、一个是页面），**但行为必须一致** ——
   * 一边转义一边不转义，出事的一定是不转义的那边，而且是在某天有人往文案里
   * 塞进外部文本的时候。当前 note 只含数字与固定文案，所以它暂时安全；
   * 「暂时安全」不是理由。
   */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * 把标出来的那几处列成几行。
   *
   * ⚠️ 光说「有 3 处要看的」等于没说：人得自己去满图找那些点，而**没人会为了一个数字去找**。
   * 横幅的第一句就该是「哪几处」，悬停只是它的补充（悬停能看全文，这里是摘要）。
   */
  function listMarks(drawn) {
    return drawn
      .map((m) => {
        const g = document.querySelector('[data-node-id="' + m.node + '"]');
        const label = (g && g.getAttribute('data-node-label')) || m.node;
        const dot = m.level === 'bad' ? '#e5484d' : '#f5a524';
        const note = m.note.length > 90 ? m.note.slice(0, 90) + '…' : m.note;
        // 有出口的写成链接：横幅是第一眼看到的东西，出口就该在这儿，而不是让人回图上找那个点
        const head =
          m.href && hookable()
            ? '<a href="' + esc(m.href) + '" style="color:inherit">' + esc(label) + '</a>'
            : esc(label);
        return '<br><span style="color:' + dot + '">●</span> <b>' + head + '</b> —— ' + esc(note);
      })
      .join('');
  }

  function badge(nodeId, level, note, href) {
    const g = document.querySelector('[data-node-id="' + nodeId + '"]');
    if (!g) return false;
    const rect = g.querySelector('rect:not(.c-mask)');
    if (!rect) return false;

    const x = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width'));
    const y = Number(rect.getAttribute('y'));

    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', '6');
    dot.setAttribute('class', 'live-badge live-badge-' + level + (level === 'bad' ? ' live-pulse' : ''));

    const t = document.createElementNS(NS, 'title');
    t.textContent = note;
    dot.appendChild(t);

    // 有出口就包一层链接。
    // **「有东西在等人」而不给一条走到人那里的路，这个标记就只是把话说了一半** ——
    // 读的人知道了有事，但还是得自己回控制台、自己找到那一页。
    if (href) {
      const a = document.createElementNS(NS, 'a');
      a.setAttribute('href', href);
      a.setAttribute('target', '_self');
      a.setAttribute('class', 'live-jumpable');
      a.appendChild(dot);
      g.appendChild(a);
    } else {
      g.appendChild(dot);
    }

    // 同时挂到节点自己的 title 上：悬停整张卡片时也能看见，不用正好指到那个点
    const title = g.querySelector('title');
    if (title) title.textContent = (title.textContent || '') + ' ｜ ' + note;
    return true;
  }

  /** 「多久以前」—— 与 heartbeat.ts 的 humanDuration 同口径，这里是它的前端副本 */
  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '时刻未知';
    const m = Math.round(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  /** 本地时刻，写到分钟 —— 快照要能被人拿去对时间 */
  function stamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '时刻未知';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function apply(ov, source) {
    const marks = [];
    const d = ov.daemon || {};

    // —— 轮询：平台还在不在跑 ——
    if (d.status === 'stopped' || d.status === 'never') {
      marks.push({
        node: 'poll',
        level: 'bad',
        note: '常驻没在跑 —— ' + (d.note || '') + '。在它被拉起来之前，没有任何东西在看着仓库',
      });
    } else if (d.status === 'late') {
      marks.push({ node: 'poll', level: 'warn', note: '常驻迟了 —— ' + (d.note || '') });
    }

    // —— 最近出过事：连片失败（格带只铺 4 小时，这类事早滑出去了）——
    if (ov.failures) {
      const f = ov.failures;
      marks.push({
        node: 'poll',
        level: 'warn',
        href: '/#failures',
        note:
          '最近 7 天连着失败过 ' + f.longestRun + ' 轮（共 ' + f.failed + '/' + f.total + ' 轮失败）' +
          (f.commonError ? '，多数是 ' + f.commonError : '') +
          '，点它看每一段的时刻与错误原文',
      });
    }

    // —— 判据与「判断没做成」 ——
    let errs = 0;
    let misses = 0;
    let hits = 0;
    for (const s of ov.stats || []) {
      errs += s.error || 0;
      misses += s.miss || 0;
      hits += s.hit || 0;
    }
    if (errs > 0) {
      marks.push({
        node: 'error',
        level: 'bad',
        note: errs + ' 次判断没做成 —— 不是「没问题」，是这一路判断没有真的发生',
      });
      marks.push({ node: 'judge', level: 'warn', note: '有 ' + errs + ' 次判定落成「没做成」' });
    }

    // —— 与控制台有关的两步：有多少在等人 ——
    //
    // ⚠️ 只标「回写反应」那一格，不在「控制台 / MCP」上再标一遍。
    // 那本来是同一批记录的两个侧面（入口侧 / 动作侧），标两次会让人以为是两件事 ——
    // 而「图上有几处要看的」这个数字一旦虚高，它就不再可信了。
    if (ov.pendingCount > 0) {
      marks.push({
        node: 'reaction',
        level: 'warn',
        href: '/#todo',
        note:
          ov.pendingCount +
          ' 条还没回写 —— 观察期的分母就靠它，点这个点直接去处理',
      });
    }
    if (ov.errorPendingCount > 0) {
      marks.push({
        node: 'error',
        level: 'bad',
        note: '另有 ' + ov.errorPendingCount + ' 次没做成的判断还没被回应',
      });
    }

    // —— 架构图（母机自己）的那一组 ——
    // 同一份 overlay 服务两种图：流程图标 poll/judge/error/console/reaction，
    // 结构图标 daemon/policies/store/...。badge() 找不到节点就直接跳过，
    // 所以两套规则放在一起是安全的 —— 但**别让它们互相依赖顺序**。
    if (document.querySelector('[data-node-id="daemon"]')) {
      if (d.status === 'stopped' || d.status === 'never') {
        marks.push({
          node: 'daemon',
          level: 'bad',
          href: '/#status',
          note: '常驻没在跑 —— 整台机器里没有东西在转，点它看最后一次心跳是什么时候',
        });
      } else if (d.status === 'late') {
        marks.push({
          node: 'daemon',
          level: 'warn',
          href: '/#status',
          note: '常驻迟了 —— 已经在漏轮次，点它看格带上是哪几片空了',
        });
      } else if (ov.failures) {
        marks.push({
          node: 'daemon',
          level: 'warn',
          href: '/#failures',
          note: '在跑，但最近 7 天连着失败过 ' + ov.failures.longestRun + ' 轮 —— 点它看是哪几段',
        });
      }

      if (errs > 0) {
        marks.push({
          node: 'policies',
          level: 'bad',
          note: errs + ' 次判定落成「没做成」—— 那一路判断没有真的发生',
        });
      }

      if (ov.pendingCount > 0) {
        marks.push({
          node: 'human',
          level: 'warn',
          href: '/#todo',
          note: '有 ' + ov.pendingCount + ' 条在等你回写 —— 这个环就断在这儿，点它去处理',
        });
        marks.push({ node: 'briefing', level: 'warn', note: '今天有内容要说' });
      }
      if (ov.errorPendingCount > 0) {
        marks.push({ node: 'briefing', level: 'bad', note: '有没做成的判定还没被回应' });
      }

      // 探针：另一个东西还在不在。
      //
      // ⚠️ 这条**能**显示在图上是有点反直觉的：图就挂在控制台上，控制台挂了图也打不开。
      // 但它显示的是「**常驻最近探到控制台不通**」—— 探的人是常驻，不是这个页面。
      // 所以这张图此刻还开着，只说明「探的那一刻之后它又起来了」或「探的是别的地址」；
      // 真打不开的时候，说这件事的是简报和 MCP，不是这里。
      const probe = d.last ? d.last.probe : undefined;
      if (probe && probe.ok === false) {
        marks.push({
          node: 'console',
          level: 'bad',
          note: '常驻最近一轮探它不通：' + (probe.error || '没给原因'),
        });
      }

      // ⚠️ 模型这一格必须看**心跳里记的那个**（跑判断的进程用它），
      // 不能用 `ov.model` —— 那是**读这个库的进程**（生成脚本 / 控制台）的环境，
      // 而它们通常没有 LLM 变量。拿它判断，图上会凭空多一个红点，
      // 让人去查一个本来好好的配置。同一个坑在控制台横幅上已经跌过一次。
      const beatModel = d.last ? d.last.modelConfigured : undefined;
      if (beatModel === false) {
        marks.push({
          node: 'llm',
          level: 'bad',
          note: '常驻报的模型没配上（' + (d.last.model || '?') + '）—— 依赖它的那条策略会全落「没做成」',
        });
      }

      if (!ov.failures && (d.status === 'alive' || d.status === undefined)) {
        marks.push({ node: 'daemon', level: null, note: '在跑' });
      }
    }

    const drawn = marks.filter(
      (m) => m.level && badge(m.node, m.level, m.note, hookable() ? m.href : undefined),
    );
    const bad = drawn.filter((m) => m.level === 'bad').length;
    const warn = drawn.filter((m) => m.level === 'warn').length;
    const summary = d.status === 'alive' ? '平台在跑' : '平台状态：' + d.status;
    const head = drawn.length
      ? `图上有 <b>${drawn.length} 处</b>要看的（${bad} 红 = 有问题 · ${warn} 黄 = 有东西在等人）`
      : `图上没有要看的步骤 —— 累计 ${hits} 命中 / ${misses} 未命中`;
    const tail = drawn.length ? listMarks(drawn) : '';

    if (source === 'baked') {
      // 快照必须自报时刻。一份看不出时刻的快照与「此刻」长得一模一样。
      banner(
        `<b>状态快照</b> · ${stamp(ov.at)} 生成，<b>不是现在</b> · ${summary} · ${head}${tail}` +
          `<br><span style="color:#777">想看此刻的：从控制台打开这个页面（同源才拉得到数据）</span>`,
        'snap',
        0,
      );
    } else {
      banner(
        `<b>${summary}</b> · ${head}${tail}`,
        drawn.length === 0 ? 'ok' : bad > 0 ? 'bad' : 'warn',
        0,
      );
    }
  }

  // 应用条先挂上：它是壳，不该等数据；而且状态拉不到时，它正是「怎么回去」的那条路。
  appbar();

  const baked = window.__LIVE_STATE__ || null;

  // 从控制台打开（http/https）时优先拉实时的；双击打开（file://）时直接用烤进去的。
  // 拉失败**不静默退回快照** —— 那会让人以为看的是此刻，实际是几天前的。
  if (location.protocol === 'file:') {
    if (baked) apply(baked, 'baked');
    else {
      banner(
        '⚠️ 这份 HTML 里没有烤进去的状态，而 <code>file://</code> 打不开时也拉不到控制台 —— ' +
          '所以图上不会有任何标记。<b>「没有标记」不等于「一切正常」</b>。' +
          '要带状态的版本：跑 <code>npm run diagram:live</code> 重新生成。',
        'bad',
      );
    }
  } else {
    fetch('api/overview', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((ov) => apply(ov, 'live'))
      .catch((e) => {
        banner(
          '⚠️ <b>没拉到平台状态</b>（' + (e && e.message ? e.message : e) + '）—— ' +
            '所以这张图上<b>没有任何标记</b>，而「没有标记」不等于「一切正常」。' +
            '控制台服务在跑吗？<a href="/">回控制台</a>',
          'bad',
        );
      });
  }
})();
