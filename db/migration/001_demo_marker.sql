-- 这是一次演练用的迁移脚本。
-- 它存在的唯一目的，是让「敏感路径」那条判据在这个 PR 上有一个真实的命中对象。
CREATE TABLE IF NOT EXISTS demo_marker (
  id   INTEGER PRIMARY KEY,
  note TEXT
);
