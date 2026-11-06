#!/usr/bin/env node
// Проверка справочника: node validate.js [путь к html] [--links]
// Извлекает первый <script> из ai-engineer.html, выполняет его без DOM
// и печатает ошибки validateData(). В конце: RESULT: PASS или RESULT: FAIL.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const htmlPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || path.join(__dirname, "ai-engineer.html");
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
let page = null;
try {
  vm.runInContext(
    `${script}\n;globalThis.__page = { dataIssues, validateData, UI, BLOCKS, TOPICS, GLOSSARY, CHANGELOG };`,
    sandbox,
    { filename: htmlPath },
  );
  page = sandbox.__page;
  failures.push(...page.dataIssues);
} catch (error) {
  failures.push(`Скрипт упал при выполнении: ${error.stack || error}`);
}

// ─── Самопроверка валидатора: сломанные данные должны ловиться ───
function brokenCases() {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const base = () => clone({ UI: page.UI, BLOCKS: page.BLOCKS, TOPICS: page.TOPICS, GLOSSARY: page.GLOSSARY, CHANGELOG: page.CHANGELOG });
  const topic = (data) => data.TOPICS[0];
  return [
    ["нет перевода", (d) => { delete topic(d).what.es; }, /what: нужен текст/],
    ["пустой перевод", (d) => { topic(d).title.en = "  "; }, /title: нужен текст/],
    ["нет перевода в UI", (d) => { d.UI.appTitle = { ru: "x", en: "y" }; }, /UI\.appTitle/],
    ["повтор id", (d) => { d.TOPICS[1].id = d.TOPICS[0].id; }, /повторяющийся id/],
    ["id не kebab-case", (d) => { topic(d).id = "Bad_Id"; }, /kebab-case/],
    ["нет блока", (d) => { topic(d).block = "nope"; }, /нет блока «nope»/],
    ["битая prereq", (d) => { topic(d).prereq = ["nope"]; }, /prereq: нет темы «nope»/],
    ["битая ссылка на термин", (d) => { topic(d).concepts = ["nope"]; }, /нет термина «nope»/],
    ["цикл prereq", (d) => { d.TOPICS[0].prereq = [d.TOPICS[1].id]; d.TOPICS[1].prereq = [d.TOPICS[0].id]; }, /цикл в prereq/],
    ["плохая дата", (d) => { topic(d).checked = "2026-02-30"; }, /checked должен быть датой/],
    ["http-ссылка", (d) => { topic(d).resources[0].url = "http://example.com"; }, /https:\/\//],
    ["нет ресурсов", (d) => { topic(d).resources = []; }, /хотя бы один ресурс/],
    ["плохой приоритет", (d) => { d.BLOCKS[0].priority = "high"; }, /priority должен быть/],
    ["термин без темы", (d) => { d.GLOSSARY[0].topics = ["nope"]; }, /GLOSSARY\..*нет темы/],
    ["лента без порядка", (d) => {
      const entry = (date) => ({ date, title: page.UI.appTitle, text: page.UI.appTitle, topics: [], source: "https://example.com" });
      d.CHANGELOG = [entry("2026-01-01"), entry("2026-02-01")];
    }, /от новых к старым/],
  ].map(([name, mutate, expected]) => {
    const data = base();
    mutate(data);
    return { name, expected, issues: page.validateData(data) };
  });
}

if (page) {
  for (const { name, expected, issues } of brokenCases()) {
    if (!issues.some((issue) => expected.test(issue))) {
      failures.push(`Самопроверка «${name}»: ошибка не поймана (${issues.join("; ") || "нет ошибок"})`);
    }
  }
}

// ─── Статические проверки разметки ───
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
for (const id of new Set(duplicateIds)) failures.push(`Повторяющийся id="${id}"`);

if (!/MVP \d+\.\d+/.test(html)) failures.push("В футере нет версии MVP");
if (!/\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Madrid\)/.test(html)) failures.push("В футере нет даты обновления (Madrid)");

// ─── Проверка ссылок (по запросу): node validate.js --links ───
async function checkLinks() {
  const urls = new Set();
  for (const topic of page.TOPICS) for (const resource of topic.resources) urls.add(resource.url);
  for (const entry of page.CHANGELOG) urls.add(entry.source);
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (!response.ok) failures.push(`Ссылка ${url}: HTTP ${response.status}`);
      else console.log("✓", url);
    } catch (error) {
      failures.push(`Ссылка ${url}: ${error.cause?.code || error.message}`);
    }
  }
}

(async () => {
  if (page && process.argv.includes("--links")) await checkLinks();
  for (const failure of failures) console.log("✗", failure);
  console.log(failures.length ? `RESULT: FAIL (${failures.length})` : "RESULT: PASS");
  process.exit(failures.length ? 1 : 0);
})();
