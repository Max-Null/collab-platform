/**
 * 极简 glob 匹配。
 *
 * 只实现需要的三种通配：`**`（跨目录）、`*`（段内）、`?`（单字符）。
 * 不引第三方库 —— 与既有自建 MCP 的零依赖风格一致。
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;

  while (i < glob.length) {
    const c = glob[i]!;

    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 连同后一个斜杠一起吃掉，使 `**/x` 也能匹配顶层的 `x`
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }

  return new RegExp(`^${re}$`);
}
