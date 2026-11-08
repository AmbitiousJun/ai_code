const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");

class ReplayStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, groups TEXT NOT NULL,
      total INTEGER NOT NULL, rowIndex INTEGER DEFAULT 0, pathIndex INTEGER DEFAULT 0
    )`);
  }
  create(cfg, groups, total, url) {
    const id = randomUUID();
    const date = new Date().toLocaleString("zh-CN", {timeZone:"Asia/Shanghai", hour12:false});
    const name = new URL(url).hostname + " · " + date + " · " + id.slice(0, 6);
    this.db.prepare("INSERT INTO tasks(id,name,config,groups,total) VALUES(?,?,?,?,?)")
      .run(id, name, JSON.stringify(cfg), JSON.stringify([...groups]), total);
    return id;
  }
  list() {
    return this.db.prepare("SELECT id,name,total,rowIndex,pathIndex FROM tasks ORDER BY rowid DESC").all();
  }
  load(id) {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!task) throw Error("重放任务不存在");
    return {...task, config:JSON.parse(task.config), groups:new Map(JSON.parse(task.groups))};
  }
  advance(id, rowIndex, pathIndex) {
    this.db.prepare("UPDATE tasks SET rowIndex=?, pathIndex=? WHERE id=?").run(rowIndex,pathIndex,id);
  }
  rename(id, name) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
      throw Error("任务名称应为 1–120 个字符");
    if (!this.db.prepare("UPDATE tasks SET name=? WHERE id=?").run(name.trim(),id).changes)
      throw Error("重放任务不存在");
  }
  remove(ids, active) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || id === active))
      throw Error("请选择可删除的重放任务，运行中的任务请先停止");
    this.db.prepare("DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
  }
}
module.exports = {ReplayStore};
