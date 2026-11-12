const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");

class ReplayStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, groups TEXT NOT NULL,
      total INTEGER NOT NULL, rowIndex INTEGER DEFAULT 0, pathIndex INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS replay_progress (
      task TEXT REFERENCES tasks(id) ON DELETE CASCADE, env INTEGER, nextPath INTEGER,
      PRIMARY KEY(task, env)
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
    const progress = new Map(this.db.prepare("SELECT env,nextPath FROM replay_progress WHERE task=?")
      .all(id).map(row => [row.env, row.nextPath]));
    return {...task, progress, config:JSON.parse(task.config), groups:new Map(JSON.parse(task.groups))};
  }
  // The legacy cursor covers the completed prefix. Sparse rows track later
  // environments until the prefix catches up. -1 marks a finished environment.
  checkpoint(id, env, nextPath) {
    this.db.exec("BEGIN");
    try {
      let {rowIndex, pathIndex} = this.db.prepare("SELECT rowIndex,pathIndex FROM tasks WHERE id=?").get(id);
      this.db.prepare("INSERT OR REPLACE INTO replay_progress(task,env,nextPath) VALUES(?,?,?)")
        .run(id, env, nextPath);
      if (env === rowIndex) {
        const get = this.db.prepare("SELECT nextPath FROM replay_progress WHERE task=? AND env=?");
        const remove = this.db.prepare("DELETE FROM replay_progress WHERE task=? AND env=?");
        let entry;
        while ((entry = get.get(id,rowIndex))) {
          remove.run(id,rowIndex);
          pathIndex = entry.nextPath;
          if (pathIndex >= 0) break;
          rowIndex++;
          pathIndex = 0;
        }
        this.db.prepare("UPDATE tasks SET rowIndex=?,pathIndex=? WHERE id=?").run(rowIndex,pathIndex,id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  restart(id, config, total, groups) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM replay_progress WHERE task=?").run(id);
      this.db.prepare("UPDATE tasks SET config=?, total=?, groups=coalesce(?,groups), rowIndex=0, pathIndex=0 WHERE id=?")
        .run(JSON.stringify(config), total, groups ? JSON.stringify([...groups]) : null, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  variables(id) {
    const row = this.db.prepare("SELECT config FROM tasks WHERE id=?").get(id);
    if (!row) throw Error("重放任务不存在");
    const {template, variables, variableOrder, primaryVariable, explore, exploreMode} = JSON.parse(row.config);
    return {template, variables, variableOrder, manual:explore && exploreMode === "manual", primaryVariable:primaryVariable ?? (template.includes("{gameId}") ? "gameId" : "")};
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
