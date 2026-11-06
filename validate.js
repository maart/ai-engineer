#!/usr/bin/env node
// Проверка справочника: node validate.js [путь к html]
// Извлекает первый <script> из ai-engineer.html, выполняет его без DOM
// и печатает ошибки validateData(). В конце: RESULT: PASS или RESULT: FAIL.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const htmlPath = process.argv[2] || path.join(__dirname, "ai-engineer.html");
const html = fs.readFileSync(htmlPath, "utf8");
const failures = [];

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.log("Не найден <script> в", htmlPath);
  console.log("RESULT: FAIL");
  process.exit(1);
}
const script = scriptMatch[1];
const MARKER = "const dataIssues = validateData();";
if (!script.includes(MARKER)) failures.push(`В скрипте нет маркера «${MARKER}»`);

const sandbox = { console };
vm.createContext(sandbox);
try {
  vm.runInContext(`${script}\n;globalThis.__issues = dataIssues;`, sandbox, { filename: htmlPath });
  failures.push(...sandbox.__issues);
} catch (error) {
  failures.push(`Скрипт упал при выполнении: ${error.stack || error}`);
}

// ─── Статические проверки разметки ───
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
for (const id of new Set(duplicateIds)) failures.push(`Повторяющийся id="${id}"`);

if (!/MVP \d+\.\d+/.test(html)) failures.push("В футере нет версии MVP");
if (!/\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Madrid\)/.test(html)) failures.push("В футере нет даты обновления (Madrid)");

for (const failure of failures) console.log("✗", failure);
console.log(failures.length ? `RESULT: FAIL (${failures.length})` : "RESULT: PASS");
process.exit(failures.length ? 1 : 0);
