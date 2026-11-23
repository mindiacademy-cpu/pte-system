"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Evaluate only pure scoring helpers from the real production source. Importing
// server.js would start the HTTP server and require live Supabase credentials.
const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "Missing production helper: " + name);
  const brace = source.indexOf("{", start);
  let depth = 0, quote = "", escaped = false, comment = "";
  for (let i = brace; i < source.length; i++) {
    const c = source[i], next = source[i+1];
    if (comment === "line") { if (c === "\n") comment = ""; continue; }
    if (comment === "block") { if (c === "*" && next === "/") { comment = ""; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; } if (c === quote) quote = ""; continue; }
    if (c === "/" && next === "/") { comment = "line"; i++; continue; }
    if (c === "/" && next === "*") { comment = "block"; i++; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    // Ignore braces inside regular-expression literals (e.g. Unicode \\p{L}).
    if (c === "/" && /[=(,:!]/.test(source.slice(brace, i).trimEnd().slice(-1))) {
      let inClass = false, regexEscape = false;
      for (++i; i < source.length; i++) {
        const ch = source[i];
        if (regexEscape) { regexEscape = false; continue; }
        if (ch === "\\\\") { regexEscape = true; continue; }
        if (ch === "[") inClass = true;
        if (ch === "]") inClass = false;
        if (ch === "/" && !inClass) break;
      }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) return source.slice(start, i+1); }
  }
  throw Error("Unclosed function: " + name);
}
const weightsStart = source.indexOf("const SKILL_WEIGHTS = ");
assert.ok(weightsStart >= 0);
const weightsEnd = source.indexOf(";\n", weightsStart);
const context = vm.createContext({});
vm.runInContext(source.slice(weightsStart, weightsEnd + 1) + "\n" +
  ["normalizeText","toAnswerArray","normalizeArrayForCompare","scoreSingleChoice",
   "scoreMultipleChoice","scoreArrayAnswers","scoreReorderPairs","scoreDictation",
   "scaleToPTE","buildSummary"].map(functionSource).join("\n") +
  "\nthis.scoring = {scoreSingleChoice,scoreMultipleChoice,scoreArrayAnswers,scoreReorderPairs,scoreDictation,buildSummary};", context);
const S = context.scoring;
const a = (subType, finalScore, maxScore, extra={}) => ({subType,finalScore,maxScore,...extra});

test("all 22 official item types have skill weights", () => {
  const expected = ["read_aloud","repeat_sentence","describe_image","re_tell_lecture","answer_short_question",
    "summarize_group_discussion","respond_to_a_situation","summarize_written_text","essay",
    "reading_writing_fill_blanks","reading_mcq_multiple","reorder_paragraphs","reading_fill_blanks","reading_mcq_single",
    "summarize_spoken_text","listening_mcq_multiple","listening_fill_blanks","highlight_correct_summary",
    "listening_mcq_single","select_missing_word","highlight_incorrect_words","write_from_dictation"];
  const actual = [...source.matchAll(/^  ([a-z_]+): \{ (?:speaking|writing|reading|listening):/gm)].map(x=>x[1]);
  assert.deepEqual(actual,expected);
});
test("manual Essay 23/26 overrides stale pending review", () => {
  const result = S.buildSummary([a("essay",23,26,{manualScore:23,aiDetails:{manualReviewRequired:true}})]);
  assert.equal(result.writing,81);
  assert.equal(result.overall,81);
  assert.equal(result.provisional,false);
});
test("unreviewed Essay remains provisional and earns no points", () => {
  const result=S.buildSummary([a("essay",23,26,{aiDetails:{manualReviewRequired:true}})]);
  assert.equal(result.writing,10);
  assert.equal(result.provisional,true);
});
test("manual score 0 is a valid reviewed score", () => {
  const result=S.buildSummary([a("essay",null,26,{manualScore:0,aiDetails:{manualReviewRequired:true}})]);
  assert.equal(result.writing,10);
  assert.equal(result.provisional,false);
});
test("manual speaking score overrides missing speech metadata", () => {
  const result=S.buildSummary([a("describe_image",4,5,{type:"speaking",manualScore:4,aiDetails:{speechDetected:false,manualReviewRequired:true}})]);
  assert.equal(result.speaking,74);
  assert.equal(result.provisional,false);
});
test("all maximum scores produce 90 in all skills and overall", () => {
  const items=["read_aloud","essay","reading_mcq_single","listening_mcq_single"].map(t=>a(t,10,10,{type:t==="read_aloud"?"speaking":"",aiDetails:t==="read_aloud"?{speechDetected:true,transcript:"hello"}:null}));
  const r=S.buildSummary(items);
  for(const key of ["overall","speaking","writing","reading","listening"]) assert.equal(r[key],90,key);
});
test("all zero scores produce 10", () => {
  const r=S.buildSummary(["essay","reading_mcq_single","listening_mcq_single"].map(t=>a(t,0,10)));
  for(const key of ["overall","writing","reading","listening"]) assert.equal(r[key],10,key);
});
test("scores are clamped to their maximum", () => {
  assert.equal(S.buildSummary([a("essay",999,26)]).writing,90);
  assert.equal(S.buildSummary([a("essay",-99,26)]).writing,10);
});
test("multiple choice penalizes incorrect selections and never goes negative", () => {
  assert.equal(S.scoreMultipleChoice(["A","X"],["A","B"],2),0);
  assert.equal(S.scoreMultipleChoice(["A","B"],["A","B"],2),2);
});
test("fill blanks is position-sensitive", () => {
  assert.equal(S.scoreArrayAnswers(["cat","dog"],["cat","dog"],2),2);
  assert.equal(S.scoreArrayAnswers(["dog","cat"],["cat","dog"],2),0);
});
test("reorder paragraphs awards correct adjacent pairs", () => {
  assert.equal(S.scoreReorderPairs(["A","B","C"],"A,B,C",2),2);
  assert.equal(S.scoreReorderPairs(["B","A","C"],"A,B,C",2),0);
});
test("dictation scores correct words with repeated-word cap", () => {
  assert.equal(S.scoreDictation("the the cat","the cat",2),2);
  assert.equal(S.scoreDictation("cat","the cat",2),1);
});
