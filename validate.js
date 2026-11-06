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
    `${script}\n;globalThis.__page = { dataIssues, validateData, UI, BLOCKS, TOPICS, GLOSSARY, CHANGELOG, state, parseBackup, buildBackup, normalizeTopicStatus, normalizeInbox, progressCounts, search, parseRoute, isStale, filteredTopics, setLessonStatus, applyQuizProgress, lessonPageIds, lessonCounts, topicLevels, buildNotesMarkdown, normalizeActivity, activityCounts, recordActivity, findTermMentions, normalizeCardStatus, buildDeck, LINKS_CHECKED };`,
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
  const lessonOf = (data) => data.TOPICS.find((item) => item.lesson).lesson;
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
    ["нет подписи вида ресурса", (d) => { delete d.UI.kind_video; }, /нет строки kind_video/],
    ["плохой приоритет", (d) => { d.BLOCKS[0].priority = "high"; }, /priority должен быть/],
    ["нет обратной ссылки термина", (d) => {
      const term = d.GLOSSARY.find((item) => item.id === d.TOPICS.find((t) => t.concepts.length).concepts[0]);
      term.topics = term.topics.filter((id) => id !== d.TOPICS.find((t) => t.concepts.length).id);
    }, /нет обратной ссылки/],
    ["термин без темы", (d) => { d.GLOSSARY[0].topics = ["nope"]; }, /GLOSSARY\..*нет темы/],
    ["урок: нет перевода", (d) => { lessonOf(d).sections[0].blocks.find((b) => b.text).text.es = ""; }, /lesson\.sections\[0\]\.blocks\[\d+\]\.text: нужен текст/],
    ["урок: неизвестный блок", (d) => { lessonOf(d).sections[0].blocks[0].type = "video"; }, /type должен быть одним из/],
    ["урок: повтор id части", (d) => { lessonOf(d).sections[1].id = lessonOf(d).sections[0].id; }, /lesson\.sections\[1\]: повторяющийся id/],
    ["урок: ответ вне вариантов", (d) => { lessonOf(d).quiz[0].answer = 9; }, /answer должен быть номером варианта/],
    ["урок: пустой вариант-код", (d) => { lessonOf(d).quiz[0].options[0] = " "; }, /options\[0\]: нужен непустой код/],
    ["урок: строка шпаргалки не той ширины", (d) => { lessonOf(d).cheatsheet.rows[0].pop(); }, /cheatsheet\.rows\[0\]: в строке должно быть/],
    ["урок: решение без кода", (d) => { lessonOf(d).exercises[0].solution.code = ""; }, /solution\.code: нужен непустой код/],
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

// ─── Логика без DOM: резервная копия, прогресс, поиск, адреса ───
function check(name, condition) {
  if (!condition) failures.push(`Проверка логики «${name}» не прошла`);
}

if (page) {
  const json = (value) => JSON.stringify(value);
  const firstTopic = page.TOPICS[0].id;
  check("мусор вместо копии", page.parseBackup("not json") === null);
  check("чужое приложение", page.parseBackup(json({ app: "other", version: 1 })) === null);
  check("копия из будущей версии", page.parseBackup(json({ app: "ai-engineer", version: 99 })) === null);
  const parsed = page.parseBackup(json({
    app: "ai-engineer",
    version: 1,
    topicStatus: { [firstTopic]: "applied", other: "bogus", todoTopic: "todo" },
    lessonStatus: { "t/p": "understood", "t/q": "todo", "t/r": "bogus", nokey: "applied" },
    topicNotes: { [firstTopic]: "note", empty: "  ", bad: 5 },
    quizAnswers: { [firstTopic]: { 0: 2, 1: -1, x: 1, 2: "1" }, junk: [1], empty: {} },
    inbox: [
      { id: "a", text: "link", created: "2026-11-06T10:00:00.000Z" },
      { id: "a", text: "duplicate", created: "2026-11-06T10:00:00.000Z" },
      { id: "b", text: "  ", created: "2026-11-06T10:00:00.000Z" },
      { id: "c", text: "bad date", created: "yesterday" },
      "junk",
    ],
  }));
  check("копия читается", parsed !== null);
  if (parsed) {
    check("статусы нормализуются", json(parsed.topicStatus) === json({ [firstTopic]: "applied" }));
    check("статусы урока нормализуются", json(parsed.lessonStatus) === json({ "t/p": "understood" }));
    check("заметки нормализуются", json(parsed.topicNotes) === json({ [firstTopic]: "note" }));
    check("ответы теста нормализуются", json(parsed.quizAnswers) === json({ [firstTopic]: { 0: 2 } }));
    check("входящие нормализуются", parsed.inbox.length === 1 && parsed.inbox[0].text === "link");
  }
  page.state.topicStatus = { [firstTopic]: "understood" };
  page.state.topicNotes = { [firstTopic]: "x" };
  page.state.inbox = [];
  const backup = page.buildBackup(new Date("2026-11-06T00:00:00Z"));
  const roundTrip = page.parseBackup(json(backup));
  check("копия туда и обратно", roundTrip && json(roundTrip.topicStatus) === json(page.state.topicStatus) && roundTrip.topicNotes[firstTopic] === "x");
  const counts = page.progressCounts();
  check("прогресс считает «Понял»", counts.done === 1 && counts.total === page.TOPICS.length);
  page.state.topicStatus = { [firstTopic]: "learning" };
  check("«Изучаю» не считается освоенным", page.progressCounts().done === 0);

  check("адрес главной", page.parseRoute("").view === "home");
  check("адрес темы", page.parseRoute(`#topic-${firstTopic}`).view === "topic");
  const lessonTopic = page.TOPICS.find((item) => item.lesson);
  const firstPart = lessonTopic.lesson.sections[0].id;
  check("адрес страницы урока", page.parseRoute(`#topic-${lessonTopic.id}/${firstPart}`).view === "lesson");
  check("адрес теста урока", page.parseRoute(`#topic-${lessonTopic.id}/quiz`).part === "quiz");
  check("адрес несуществующей страницы урока", page.parseRoute(`#topic-${lessonTopic.id}/nope`).view === "missing");
  check("адрес несуществующей темы",page.parseRoute("#topic-nope").view === "missing");
  check("адрес прогресса", page.parseRoute("#progress").view === "progress");
  check("поиск по русскому названию", page.search("эмбеддинги", "ru").some((r) => r.id === "embeddings"));
  check("поиск по английскому термину из русского интерфейса", page.search("embeddings", "ru").some((r) => r.id === "embeddings"));
  check("поиск без учёта ударений", page.search("similitud coseno", "es").some((r) => r.id === "cosine-similarity"));
  check("поиск по тексту урока", page.search("f-строка", "ru").some((r) => r.id === "python-basics"));
  check("поиск ведёт на страницу урока", page.search("f-строка", "ru").some((r) => r.kind === "lesson" && r.id === "python-basics" && typeof r.pid === "string"));
  check("адрес карты тем", page.parseRoute("#map").view === "map");
  const levels = page.topicLevels();
  check("карта тем содержит все темы", levels.flat().length === page.TOPICS.length);
  check("карта: тема стоит глубже своих prereq", page.TOPICS.every((topic) => topic.prereq.every((ref) => levels.findIndex((l) => l.some((x) => x.id === ref)) < levels.findIndex((l) => l.some((x) => x.id === topic.id)))));
  {
    const lt = page.TOPICS.find((item) => item.lesson);
    const pages = page.lessonPageIds(lt);
    page.state.topicStatus = {};
    page.state.lessonStatus = {};
    page.setLessonStatus(lt.id, pages[0], "learning");
    check("первая отметка урока — тема «Изучаю»", page.state.topicStatus[lt.id] === "learning");
    pages.forEach((pid) => page.setLessonStatus(lt.id, pid, "understood"));
    check("все страницы освоены — тема «Понял»", page.state.topicStatus[lt.id] === "understood");
    page.state.topicStatus[lt.id] = "applied";
    page.setLessonStatus(lt.id, pages[0], "todo");
    check("прогресс урока не понижает статус темы", page.state.topicStatus[lt.id] === "applied");
    page.state.lessonStatus = {};
    page.state.quizAnswers = { [lt.id]: Object.fromEntries(lt.lesson.quiz.map((q, i) => [i, q.answer])) };
    page.applyQuizProgress(lt.id);
    check("тест с верными ответами зачтён", page.state.lessonStatus[`${lt.id}/quiz`] === "understood");
    page.state.lessonStatus = {};
    page.state.quizAnswers = { [lt.id]: { 0: (lt.lesson.quiz[0].answer + 1) % lt.lesson.quiz[0].options.length } };
    page.applyQuizProgress(lt.id);
    check("начатый тест — «Изучаю»", page.state.lessonStatus[`${lt.id}/quiz`] === "learning");
    page.state.topicStatus = {};
    page.state.lessonStatus = {};
    page.state.quizAnswers = {};
  }
  page.state.activity = {};
  page.recordActivity(new Date("2026-11-07T12:00:00"));
  page.recordActivity(new Date("2026-11-07T13:00:00"));
  check("активность считается за день и неделю", page.activityCounts(new Date("2026-11-09T12:00:00")).week === 2 && page.activityCounts(new Date("2026-11-07T12:00:00")).today === 2);
  check("активность нормализуется", JSON.stringify(page.normalizeActivity({ "2026-11-07": 2, bad: 1, "2026-11-08": -1 })) === JSON.stringify({ "2026-11-07": 2 }));
  page.state.activity = {};
  page.state.topicNotes = { [page.TOPICS[0].id]: "моя заметка" };
  page.state.inbox = [];
  check("заметки выгружаются в Markdown", page.buildNotesMarkdown("ru").count === 1 && page.buildNotesMarkdown("ru").text.includes("моя заметка"));
  page.state.topicNotes = {};
  {
    const ids = (text, lang) => page.findTermMentions(text, lang).map((m) => m.id);
    check("термин находится с окончанием", ids("Эмбеддинги хранят в векторной базе.", "ru").includes("embedding"));
    check("английский термин в русском тексте", ids("Строим RAG для компании", "ru").includes("rag"));
    check("термин не ищется внутри слова", !ids("storage и pragma", "en").includes("rag"));
    check("испанский термин", ids("Usamos una ventana de contexto grande", "es").includes("context-window"));
  }
  check("карточки: статусы нормализуются", JSON.stringify(page.normalizeCardStatus({ a: "known", b: "review", c: "new", d: 1 })) === JSON.stringify({ a: "known", b: "review" }));
  page.state.cardStatus = { [page.GLOSSARY[0].id]: "known", [page.GLOSSARY[1].id]: "review" };
  {
    const left = page.buildDeck("left");
    check("колода «Осталось» без освоенных, повторы первыми", left.ids.length === page.GLOSSARY.length - 1 && left.ids[0] === page.GLOSSARY[1].id && !left.ids.includes(page.GLOSSARY[0].id));
    check("колода «Знаю»", page.buildDeck("known").ids.length === 1 && page.buildDeck("all").ids.length === page.GLOSSARY.length);
  }
  page.state.cardStatus = {};
  check("адрес карточек", page.parseRoute("#cards").view === "cards");
  check("дата сверки ссылок корректна и не в будущем", /^\d{4}-\d{2}-\d{2}$/.test(page.LINKS_CHECKED) && Date.parse(`${page.LINKS_CHECKED}T00:00:00Z`) <= Date.now() + 86400000);
  check("пустой поиск", page.search("   ", "ru").length === 0);
  check("адрес термина", page.parseRoute(`#term-${page.GLOSSARY[0].id}`).view === "glossary");
  check("адрес ленты", page.parseRoute("#changelog").view === "changelog");
  const now = new Date("2026-11-06T12:00:00Z");
  check("свежая тема", !page.isStale("2026-10-01", now));
  check("120 дней — ещё свежая", !page.isStale("2026-07-09", now));
  check("старая тема", page.isStale("2026-06-01", now));
  page.state.topicStatus = { [firstTopic]: "learning" };
  check("фильтр по статусу", page.filteredTopics({ status: "learning", priority: "any", stale: false }, now).map((x) => x.id).join() === firstTopic);
  check("фильтр по устаревшим", page.filteredTopics({ status: "any", priority: "any", stale: true }, new Date("2030-01-01T00:00:00Z")).length === page.TOPICS.length);
  check("фильтр по приоритету", page.filteredTopics({ status: "any", priority: "plus", stale: false }, now)
    .every((x) => page.BLOCKS.find((b) => b.id === x.block).priority === "plus"));
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
      if ([401, 403, 429].includes(response.status)) console.log("⚠", url, `HTTP ${response.status}: сайт отвечает, но не пускает бота; откройте ссылку в браузере`);
      else if (!response.ok) failures.push(`Ссылка ${url}: HTTP ${response.status}`);
      else console.log("✓", url);
    } catch (error) {
      failures.push(`Ссылка ${url}: ${error.cause?.code || error.message}`);
    }
  }
}

(async () => {
  if (page && process.argv.includes("--links")) await checkLinks();
  for (const failure of failures) console.log("✗", failure);
  if (page && process.argv.includes("--links") && !failures.length) console.log(`Ссылки в порядке. Поставьте LINKS_CHECKED = "${new Date().toISOString().slice(0, 10)}" в ai-engineer.html.`);
  console.log(failures.length ? `RESULT: FAIL (${failures.length})` : "RESULT: PASS");
  process.exit(failures.length ? 1 : 0);
})();
