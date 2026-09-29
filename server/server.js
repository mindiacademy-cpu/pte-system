const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");
const fs = require("fs")
const path = require("path");
const multer = require("multer");
const OpenAI = require("openai");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3001;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../client")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName);
  }
});

const upload = multer({ storage });

const QUESTIONS_FILE = path.join(__dirname, "questions.json");
const EXAMS_FILE = path.join(__dirname, "exams.json");
const EXAM_RESULTS_FILE = path.join(__dirname, "exam-results.json");

/**
 * PTE-like skill contribution map
 * Değerler resmi Pearson algoritması değil,
 * PTE mantığına yakın mock scoring dağılımıdır.
 */
// Practice-only communicative-skill mapping for the 22 supported PTE task types.
// These weights are internal approximations and are not Pearson's proprietary scoring weights.
const SKILL_WEIGHTS = {
  read_aloud: { speaking: 0.7, reading: 0.3 },
  repeat_sentence: { speaking: 0.7, listening: 0.3 },
  describe_image: { speaking: 1.0 },
  re_tell_lecture: { speaking: 0.7, listening: 0.3 },
  answer_short_question: { listening: 1.0 },
  summarize_group_discussion: { speaking: 0.7, listening: 0.3 },
  respond_to_a_situation: { speaking: 1.0 },
  summarize_written_text: { writing: 0.7, reading: 0.3 },
  essay: { writing: 1.0 },
  reading_writing_fill_blanks: { reading: 0.5, writing: 0.5 },
  reading_mcq_multiple: { reading: 1.0 },
  reorder_paragraphs: { reading: 1.0 },
  reading_fill_blanks: { reading: 1.0 },
  reading_mcq_single: { reading: 1.0 },
  summarize_spoken_text: { listening: 0.4, writing: 0.6 },
  listening_mcq_multiple: { listening: 1.0 },
  listening_fill_blanks: { listening: 1.0 },
  highlight_correct_summary: { listening: 0.7, reading: 0.3 },
  listening_mcq_single: { listening: 1.0 },
  select_missing_word: { listening: 1.0 },
  highlight_incorrect_words: { listening: 0.8, reading: 0.2 },
  write_from_dictation: { listening: 0.7, writing: 0.3 }
};

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function toAnswerArray(value, splitMode = "line") {
  if (Array.isArray(value)) {
    return value.flat(Infinity).map(item => String(item ?? "").trim());
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).flat(Infinity).map(item => String(item ?? "").trim());
  }

  const text = String(value ?? "").trim();
  if (!text) return [];

  if (splitMode === "comma") {
    return text.split(",").map(item => item.trim());
  }

  return text.split(/\r?\n/).map(item => item.trim());
}

function normalizeArrayForCompare(value, splitMode = "line", keepEmpty = false) {
  const arr = toAnswerArray(value, splitMode).map(normalizeText);
  return keepEmpty ? arr : arr.filter(Boolean);
}

function scoreSingleChoice(userAnswer, correctAnswer, maxScore = 10) {
  return normalizeText(userAnswer) === normalizeText(correctAnswer) ? maxScore : 0;
}

function scoreTextAnswer(userAnswer, correctAnswer, maxScore = 10) {
  return normalizeText(userAnswer) === normalizeText(correctAnswer) ? maxScore : 0;
}

function scoreByKeywords(text, keywords, maxScore = 10) {
  const normalizedText = normalizeText(text);

  const keywordList = String(keywords || "")
    .split(",")
    .map(k => normalizeText(k))
    .filter(Boolean);

  if (!keywordList.length) return 0;

  let matched = 0;

  keywordList.forEach(word => {
    if (normalizedText.includes(word)) matched++;
  });

  return Math.round((matched / keywordList.length) * maxScore * 100) / 100;
}
function scoreMultipleChoice(userAnswers, correctAnswers, maxScore = 10) {
  const user = normalizeArrayForCompare(userAnswers, "line", false);
  const correct = normalizeArrayForCompare(correctAnswers, "line", false);

  if (!correct.length) return 0;

  let correctCount = 0;

  correct.forEach(item => {
    if (user.includes(item)) correctCount++;
  });

  const wrongCount = user.filter(item => !correct.includes(item)).length;

  let score = ((correctCount - wrongCount) / correct.length) * maxScore;

  if (score < 0) score = 0;
  if (score > maxScore) score = maxScore;

  return Math.round(score * 100) / 100;
}

function scoreArrayAnswers(userAnswers, correctAnswers, maxScore = 10, splitMode = "line") {
  const user = normalizeArrayForCompare(userAnswers, splitMode, true);
  const correct = normalizeArrayForCompare(correctAnswers, splitMode, true);

  console.log("---- SCORE ARRAY ANSWERS ----");
  console.log("RAW USER:", userAnswers);
  console.log("RAW CORRECT:", correctAnswers);
  console.log("PARSED USER:", user);
  console.log("PARSED CORRECT:", correct);

  if (!correct.length) {
    console.log("NO CORRECT ANSWERS");
    return 0;
  }

  let correctCount = 0;

  for (let i = 0; i < correct.length; i++) {
    if (user[i] && user[i] === correct[i]) {
      correctCount++;
    }
  }

  console.log("CORRECT COUNT:", correctCount, "/", correct.length);

  const final = Math.round((correctCount / correct.length) * maxScore * 100) / 100;
  console.log("FINAL SCORE:", final);
  console.log("-----------------------------");

  return final;
}

function getCorrectArray(question, splitMode = "line") {
  if (Array.isArray(question.correctAnswers) && question.correctAnswers.length) return question.correctAnswers;
  if (Array.isArray(question.answer) && question.answer.length) return question.answer;
  return toAnswerArray(question.answerKey || question.correctAnswer || question.answer || "", splitMode).filter(Boolean);
}

function scoreReorderPairs(userAnswers, correctAnswers, maxScore = 10) {
  const user = toAnswerArray(userAnswers, "line").map(normalizeText);
  const correct = toAnswerArray(correctAnswers, "comma").map(normalizeText).filter(Boolean);
  if (correct.length < 2) return 0;
  let matched = 0;
  for (let i = 0; i < correct.length - 1; i++) {
    const pos = user.indexOf(correct[i]);
    if (pos >= 0 && user[pos + 1] === correct[i + 1]) matched++;
  }
  return Math.round((matched / (correct.length - 1)) * maxScore * 100) / 100;
}

function scoreDictation(userAnswer, correctAnswer, maxScore = 10) {
  const user = normalizeText(userAnswer).split(" ").filter(Boolean);
  const correct = normalizeText(correctAnswer).split(" ").filter(Boolean);
  if (!correct.length) return 0;

  // Longest common subsequence: credits correctly spelled words while preserving sentence order.
  const dp = Array.from({ length: correct.length + 1 }, () => Array(user.length + 1).fill(0));
  for (let i = 1; i <= correct.length; i++) {
    for (let j = 1; j <= user.length; j++) {
      dp[i][j] = correct[i - 1] === user[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return Math.round((dp[correct.length][user.length] / correct.length) * maxScore * 100) / 100;
}

function calculateAutoScore(question, submittedAnswer) {
  const maxScore = Number(question.points || 10);
  const subType = question.subType || "";

  if (["reading_mcq_single","listening_mcq_single","highlight_correct_summary","select_missing_word"].includes(subType)) {
    return scoreSingleChoice(submittedAnswer, question.correctAnswer || question.answer, maxScore);
  }
  if (["reading_mcq_multiple","listening_mcq_multiple"].includes(subType)) {
    return scoreMultipleChoice(submittedAnswer, getCorrectArray(question), maxScore);
  }
  if (["reading_fill_blanks","reading_writing_fill_blanks","listening_fill_blanks"].includes(subType)) {
    return scoreArrayAnswers(submittedAnswer, getCorrectArray(question), maxScore, "line");
  }
  if (subType === "reorder_paragraphs") {
    return scoreReorderPairs(submittedAnswer, question.answerKey || question.answer || "", maxScore);
  }
  if (subType === "write_from_dictation") {
    return scoreDictation(submittedAnswer, question.answerKey || question.answer || "", maxScore);
  }
  if (subType === "highlight_incorrect_words") {
    const selected = toAnswerArray(submittedAnswer, "line").map(String);
    const transcriptWords = String(question.textContent || "").trim().split(/\s+/).filter(Boolean);
    const authored = getCorrectArray(question).map(String);
    const correctIndexes = authored.map(value => {
      if (/^\d+$/.test(value)) return value;
      const normalizedTarget = normalizeText(value);
      const index = transcriptWords.findIndex(word => normalizeText(word) === normalizedTarget);
      return index >= 0 ? String(index) : value;
    });
    return scoreMultipleChoice(selected, correctIndexes, maxScore);
  }
  if (question.type === "writing" || subType === "summarize_spoken_text") {
    return scoreByKeywords(submittedAnswer, question.keywords || "", maxScore);
  }
  return 0;
}

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

ensureFile(QUESTIONS_FILE, []);
ensureFile(EXAMS_FILE, []);
ensureFile(EXAM_RESULTS_FILE, []);

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw || "[]");
  } catch (error) {
    console.error(`JSON read error for ${filePath}:`, error);
    return [];
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function getDefaultPoints(subType) {
  if (
    subType === "read_aloud" ||
    subType === "repeat_sentence" ||
    subType === "reading_writing_fill_blanks" ||
    subType === "write_from_dictation"
  ) {
    return 25;
  }

  if (
    subType === "describe_image" ||
    subType === "re_tell_lecture" ||
    subType === "essay" ||
    subType === "summarize_written_text" ||
    subType === "summarize_group_discussion" ||
    subType === "respond_to_a_situation" ||
    subType === "listening_fill_blanks" ||
    subType === "summarize_spoken_text"
  ) {
    return 15;
  }

  return 10;
}

function normalizeQuestion(q) {
  const safeSubType = q.subType || "";

  return {
    id: q.id ? String(q.id) : Date.now().toString(),
    type: q.type || "",
    subType: safeSubType,
    title: q.title || "",
    prompt: q.prompt || "",
    points: Number(q.points || getDefaultPoints(safeSubType)),

    time: Number(q.time ?? 60),
    prepareTime: Number(q.prepareTime ?? 25),
    recordTime: Number(q.recordTime ?? 40),

    audioUrl: q.audioUrl || "",
    imageUrl: q.imageUrl || "",
    textContent: q.textContent || "",

    options: Array.isArray(q.options) ? q.options : [],

    evaluationType: q.evaluationType || "keywords",
    keywords: q.keywords || "",
    answerKey: q.answerKey || "",
    correctAnswer: q.correctAnswer || "",
    correctAnswers: Array.isArray(q.correctAnswers)
      ? q.correctAnswers
      : toAnswerArray(q.correctAnswers || "", "line").filter(Boolean),

    answer: q.answer || q.answerKey || ""
  };
}

function normalizeExamResult(exam) {
  return {
    id: exam.id ? String(exam.id) : Date.now().toString(),
    candidateName: exam.candidateName || "",
    candidateSurname: exam.candidateSurname || "",
    candidatePhone: exam.candidatePhone || "",
    candidateEmail: exam.candidateEmail || "",
    candidateId: exam.candidateId || "",
    examCode: exam.examCode || "",
    kvkkApproval: exam.kvkkApproval || "",
    startedAt: exam.startedAt || "",
    finishedAt: exam.finishedAt || new Date().toISOString(),
    answers: Array.isArray(exam.answers) ? exam.answers : [],
    summary: exam.summary || {
      overall: 10,
      speaking: 10,
      writing: 10,
      reading: 10,
      listening: 10
    }
  };
}

function scaleToPTE(rawPercent) {
  const safe = Math.max(0, Math.min(1, Number(rawPercent || 0)));
  return Math.round(10 + safe * 80);
}

function buildSummary(answers) {
  const safeAnswers = Array.isArray(answers) ? answers : [];

  const totals = {
    speaking: { earned: 0, possible: 0 },
    writing: { earned: 0, possible: 0 },
    reading: { earned: 0, possible: 0 },
    listening: { earned: 0, possible: 0 }
  };

  let overallEarned = 0;
  let overallPossible = 0;

  safeAnswers.forEach(answer => {
    const subType = answer.subType || "";
    const weights = SKILL_WEIGHTS[subType] || {};
    const finalScore = Number(answer.finalScore || 0);
    const maxScore = Number(answer.maxScore || 10);

    overallEarned += finalScore;
    overallPossible += maxScore;

    Object.entries(weights).forEach(([skill, weight]) => {
      totals[skill].earned += finalScore * weight;
      totals[skill].possible += maxScore * weight;
    });
  });

  const speakingRaw = totals.speaking.possible ? totals.speaking.earned / totals.speaking.possible : 0;
  const writingRaw = totals.writing.possible ? totals.writing.earned / totals.writing.possible : 0;
  const readingRaw = totals.reading.possible ? totals.reading.earned / totals.reading.possible : 0;
  const listeningRaw = totals.listening.possible ? totals.listening.earned / totals.listening.possible : 0;
  const overallRaw = overallPossible ? overallEarned / overallPossible : 0;

  const speakingScore = scaleToPTE(speakingRaw);
  const writingScore = scaleToPTE(writingRaw);
  const readingScore = scaleToPTE(readingRaw);
  const listeningScore = scaleToPTE(listeningRaw);

  // Pearson states Overall is based on performance across the whole test, not the
  // arithmetic mean of the four communicative-skill scores. This practice engine
  // therefore scales the accumulated item performance independently.
  const overallScore = scaleToPTE(overallRaw);

  return {
    overall: overallScore,
    speaking: speakingScore,
    writing: writingScore,
    reading: readingScore,
    listening: listeningScore
  };
}

function buildEvaluation(summary) {
  const scores = {
    speaking: Number(summary?.speaking || 0),
    writing: Number(summary?.writing || 0),
    reading: Number(summary?.reading || 0),
    listening: Number(summary?.listening || 0)
  };

  const labels = {
    speaking: "Speaking",
    writing: "Writing",
    reading: "Reading",
    listening: "Listening"
  };

  const recommendations = {
    speaking: "Akıcılık, telaffuz, ritim, vurgu ve sözlü anlatım",
    writing: "Grammar, sentence structure, vocabulary ve fikir geliştirme",
    reading: "Vocabulary, collocation, word formation ve okuma hızı",
    listening: "Ana fikir, detay, note-taking, dictation ve spelling"
  };

  function getLevel(score) {
    if (score >= 70) return "GÜÇLÜ ALAN";
    if (score >= 55) return "İYİ / GÜÇLÜ";
    if (score >= 40) return "GELİŞTİRİLEBİLİR";
    return "ÖNCELİKLİ GELİŞTİRİLMELİ";
  }

  function getEvaluation(skill, score) {
    if (skill === "speaking") {
      if (score >= 70)
        return "Speaking adayın güçlü becerilerinden biridir. Sözlü İngilizce üretiminde güçlü bir performans görülmektedir. Mevcut seviyeyi korumak ve daha ileri taşımak için akıcılık, telaffuz, ritim ve vurgu çalışmalarına devam edilmelidir.";

      if (score >= 55)
        return "Speaking performansı iyi düzeydedir. Daha yüksek skor için akıcılık, pronunciation ve oral fluency çalışmalarına ağırlık verilmesi önerilir.";

      if (score >= 40)
        return "Speaking performansı geliştirilebilir düzeydedir. Akıcılık, doğru telaffuz, ritim ve kesintisiz konuşma çalışmalarına düzenli olarak devam edilmelidir.";

      return "Speaking öncelikli geliştirilmesi gereken alanlardan biridir. Akıcılık, telaffuz, ritim ve temel sözlü üretim çalışmalarına yoğunlaşılması önerilir.";
    }

    if (skill === "writing") {
      if (score >= 70)
        return "Writing güçlü bir seviyededir. Akademik yazım kalitesini korumak için grammar accuracy, vocabulary range ve fikir organizasyonu çalışmalarına devam edilmelidir.";

      if (score >= 55)
        return "Writing iyi düzeydedir. Daha yüksek skor için grammar doğruluğu, akademik kelime kullanımı, cümle çeşitliliği ve fikirlerin açık biçimde geliştirilmesi üzerinde çalışılmalıdır.";

      if (score >= 40)
        return "Writing performansı geliştirmeye açıktır. Grammar doğruluğu, sentence structure, akademik vocabulary ve fikir organizasyonu üzerinde düzenli çalışma önerilir.";

      return "Writing öncelikli geliştirilmesi gereken alanlardan biridir. Daha yüksek skor için grammar doğruluğu, cümle yapısı, akademik kelime kullanımı ve fikirlerin açık biçimde geliştirilmesi üzerinde çalışılmalıdır.";
    }

    if (skill === "reading") {
      if (score >= 70)
        return "Reading güçlü bir seviyededir. Akademik vocabulary, collocation ve hızlı anlamlandırma çalışmalarıyla mevcut performans korunabilir.";

      if (score >= 55)
        return "Reading adayın güçlü alanlarından biridir. Skoru daha ileri taşımak için akademik vocabulary, collocation, word formation ve zaman yönetimi çalışmalarına devam edilmelidir.";

      if (score >= 40)
        return "Reading performansı geliştirilebilir düzeydedir. Vocabulary, collocation, bağlamdan anlam çıkarma ve okuma hızına ağırlık verilmesi önerilir.";

      return "Reading öncelikli geliştirilmesi gereken alanlardan biridir. Akademik vocabulary, temel anlam çıkarma, collocation, word formation ve zaman yönetimi üzerinde çalışılmalıdır.";
    }

    if (skill === "listening") {
      if (score >= 70)
        return "Listening güçlü bir seviyededir. Farklı aksanlar, akademik içerikler ve ayrıntı yakalama çalışmalarıyla mevcut seviye korunabilir.";

      if (score >= 55)
        return "Listening iyi düzeydedir. Daha yüksek skor için ana fikir ve detayları ayırt etme, note-taking, dictation ve spelling çalışmalarına devam edilmelidir.";

      if (score >= 40)
        return "Listening performansı geliştirmeye açıktır. Ana fikir ve detayları ayırt etme, anahtar kelimeleri yakalama, note-taking ve spelling çalışmalarına ağırlık verilmelidir.";

      return "Listening öncelikli geliştirilmesi gereken alanlardan biridir. Ana fikir ve detayları ayırt etme, anahtar kelimeleri yakalama, note-taking, dictation ve spelling çalışmalarına ağırlık verilmelidir.";
    }

    return "";
  }

  const ordered = Object.entries(scores)
    .sort((a, b) => a[1] - b[1]);

  const weakest = ordered[0];
  const secondWeakest = ordered[1];
  const strongest = ordered[ordered.length - 1];

  const overall = Number(summary?.overall || 0);

  const generalEvaluation =
    `Adayın genel performansında beceriler arasında farklılıklar görülmektedir. ` +
    `${labels[strongest[0]]} ${strongest[1]} puan ile en güçlü alan olarak öne çıkmaktadır. ` +
    `${labels[weakest[0]]} ${weakest[1]} puan ise öncelikli geliştirilmesi gereken alandır. ` +
    `Mevcut Overall Score ${overall} olup, özellikle ${labels[weakest[0]]} ve ` +
    `${labels[secondWeakest[0]]} alanlarında sağlanacak gelişim genel performansın yükselmesine katkı sağlayacaktır.`;

  const result = {
    generalEvaluation,

    speaking: {
      score: scores.speaking,
      level: getLevel(scores.speaking),
      evaluation: getEvaluation("speaking", scores.speaking)
    },

    writing: {
      score: scores.writing,
      level: getLevel(scores.writing),
      evaluation: getEvaluation("writing", scores.writing)
    },

    reading: {
      score: scores.reading,
      level: getLevel(scores.reading),
      evaluation: getEvaluation("reading", scores.reading)
    },

    listening: {
      score: scores.listening,
      level: getLevel(scores.listening),
      evaluation: getEvaluation("listening", scores.listening)
    },

    priorities: ordered.map(([skill, score], index) => ({
      rank: index + 1,
      skill: labels[skill],
      score,
      recommendation: recommendations[skill]
    })),

    conclusion:
      `Adayın öncelikle ${labels[weakest[0]]} ve ${labels[secondWeakest[0]]} ` +
      `becerilerine odaklanması önerilir. Bu alanlarda sağlanacak gelişim, mevcut ` +
      `${overall} puanlık genel performansın daha dengeli ve daha yüksek bir seviyeye taşınmasına yardımcı olacaktır.`
  };

  return result;
}

async function generateDetailedEvaluation(summary, answers) {
  try {
    const simplifiedAnswers = (answers || []).map(a => ({
      type: a.type || "",
      subType: a.subType || "",
      title: a.title || "",
      finalScore: Number(a.finalScore || 0),
      maxScore: Number(a.maxScore || 0),
      aiFeedback: a.aiFeedback || ""
    }));

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
You are an expert PTE Academic performance evaluator.

Candidate scores:
Overall: ${summary.overall}
Speaking: ${summary.speaking}
Writing: ${summary.writing}
Reading: ${summary.reading}
Listening: ${summary.listening}

Question-level results:
${JSON.stringify(simplifiedAnswers, null, 2)}

Create a detailed professional evaluation in Turkish.

Rules:
- Do NOT say this is an official Pearson evaluation.
- Base your conclusions only on the supplied scores and question results.
- Identify strengths and weaknesses.
- Give practical, specific improvement recommendations.
- Avoid generic filler.
- Keep the tone professional and suitable for a candidate score report.

Return ONLY valid JSON in this exact structure:

{
  "generalEvaluation": "Genel değerlendirme paragrafı",
  "speaking": {
    "score": ${summary.speaking},
    "level": "GÜÇLÜ ALAN veya İYİ veya GELİŞTİRİLMELİ veya ÖNCELİKLİ GELİŞTİRİLMELİ",
    "evaluation": "Speaking değerlendirmesi"
  },
  "writing": {
    "score": ${summary.writing},
    "level": "GÜÇLÜ ALAN veya İYİ veya GELİŞTİRİLMELİ veya ÖNCELİKLİ GELİŞTİRİLMELİ",
    "evaluation": "Writing değerlendirmesi"
  },
  "reading": {
    "score": ${summary.reading},
    "level": "GÜÇLÜ ALAN veya İYİ veya GELİŞTİRİLMELİ veya ÖNCELİKLİ GELİŞTİRİLMELİ",
    "evaluation": "Reading değerlendirmesi"
  },
  "listening": {
    "score": ${summary.listening},
    "level": "GÜÇLÜ ALAN veya İYİ veya GELİŞTİRİLMELİ veya ÖNCELİKLİ GELİŞTİRİLMELİ",
    "evaluation": "Listening değerlendirmesi"
  },
  "priorities": [
    {
      "rank": 1,
      "skill": "Writing",
      "score": 0,
      "recommendation": "Çalışma önerisi"
    }
  ],
  "conclusion": "Sonuç paragrafı"
}
`
    });

    const raw = response.output_text || "";
    const parsed = safeJsonParse(raw);

    if (!parsed) {
      console.error("DETAILED EVALUATION JSON ERROR:", raw);
      return null;
    }

    return parsed;

  } catch (error) {
    console.error("DETAILED EVALUATION ERROR:", error);
    return null;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

async function scoreSpeakingWithAI({ question, transcript, maxScore }) {
  if (!transcript || !transcript.trim()) {
    return { score:0, feedback:"No speaking response detected.", content:0, pronunciation:null, oralFluency:null, scoringNote:"Audio traits not estimated from transcript." };
  }
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: `Evaluate CONTENT only for this PTE Academic PRACTICE speaking response.
Task: ${question.subType || "speaking"}
Prompt: ${question.prompt || ""}
Source content: ${question.textContent || question.answerKey || ""}
Candidate transcript: ${transcript}

Return ONLY JSON: {"content":0,"feedback":""}
Use a strict 0-5 practice content rubric. Read Aloud checks prompt words; Repeat Sentence checks reproduced word sequences; open speaking tasks check relevance and coverage. Empty, irrelevant or meaningless responses receive zero. Do not score pronunciation or oral fluency from transcript text.`
  });
  const parsed = safeJsonParse(response.output_text || "") || {};
  const content = Math.max(0,Math.min(5,Number(parsed.content||0)));
  return {
    score: Math.round((content / 5) * maxScore * 100) / 100,
    content,
    pronunciation:null,
    oralFluency:null,
    feedback: parsed.feedback || "",
    scoringNote:"Practice content score only. Pronunciation and Oral Fluency require analysis of the actual audio signal and are not inferred from transcript."
  };
}

async function transcribeAudioFromUrl(audioUrl) {
  if (!audioUrl) return "";

  const relativePath = audioUrl.startsWith("/")
    ? audioUrl.slice(1)
    : audioUrl;

  const audioPath = path.join(__dirname, relativePath);

  console.log("TRANSCRIBE AUDIO PATH:", audioPath);

  if (!fs.existsSync(audioPath)) {
    console.log("AUDIO FILE NOT FOUND:", audioPath);
    return "";
  }

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "gpt-4o-mini-transcribe"
  });

  return transcription.text || "";
}

async function scoreWritingWithAI({ question, responseText, maxScore }) {
  const text = String(responseText || "").trim();
  if (!text) return { score:0, feedback:"No written response detected.", traits:{} };

  const subType = question.subType || "";
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (subType === "summarize_written_text") {
    const sentenceCount = (text.match(/[.!?]+(?=\s|$)/g) || []).length;
    const allCaps = /[A-Z]/.test(text) && !/[a-z]/.test(text);
    if (wordCount < 5 || wordCount > 75 || sentenceCount > 1 || allCaps) {
      return { score:0, feedback:"Summarize Written Text form requirement not met.", traits:{ form:0 }, wordCount };
    }
  }
  if (subType === "essay" && (wordCount < 120 || wordCount > 380)) {
    return { score:0, feedback:"Essay form requirement not met.", traits:{ form:0 }, wordCount };
  }
  if (subType === "summarize_spoken_text") {
    const allCaps = /[A-Z]/.test(text) && !/[a-z]/.test(text);
    const hasPunctuation = /[.!?,;:]/.test(text);
    if (wordCount < 40 || wordCount > 100 || allCaps || !hasPunctuation) {
      return { score:0, feedback:"Summarize Spoken Text form requirement not met.", traits:{ form:0 }, wordCount };
    }
  }

  const traitSpec = subType === "essay"
    ? "content 0-6, developmentStructureCoherence 0-6, form 0-2, generalLinguisticRange 0-6, grammar 0-2, vocabularyRange 0-2, spelling 0-2"
    : subType === "summarize_spoken_text"
      ? "content 0-4, form 0-2, grammar 0-2, vocabulary 0-2, spelling 0-2"
      : "content 0-4, form 0-1, grammar 0-2, vocabulary 0-2";

  const ai = await openai.responses.create({
    model:"gpt-4.1-mini",
    input:`Evaluate this PTE Academic PRACTICE writing response using Pearson's publicly described traits.
Task: ${subType}
Prompt/source: ${question.textContent || question.prompt || ""}
Candidate response: ${text}
Word count: ${wordCount}
Traits and maxima: ${traitSpec}

Important: Content 0 means the whole response receives zero. Apply form requirements strictly. For Summarize Written Text, it must be one complete sentence and 5-75 words. For Essay, 200-300 words earns full form credit; 120-199 or 301-380 is reduced form credit. For Summarize Spoken Text, 50-70 words earns full form credit; 40-49 or 71-100 is reduced form credit.
Return ONLY JSON: {"traits":{},"feedback":""}`
  });
  const parsed=safeJsonParse(ai.output_text||"")||{};
  const traits=parsed.traits||{};
  const maxima = subType==="essay"
    ? {content:6,developmentStructureCoherence:6,form:2,generalLinguisticRange:6,grammar:2,vocabularyRange:2,spelling:2}
    : subType==="summarize_spoken_text"
      ? {content:4,form:2,grammar:2,vocabulary:2,spelling:2}
      : {content:4,form:1,grammar:2,vocabulary:2};
  if(Number(traits.content||0)<=0) return {score:0,feedback:parsed.feedback||"Content criterion not met.",traits,wordCount};
  let earned=0, possible=0;
  for(const [k,m] of Object.entries(maxima)){earned+=Math.max(0,Math.min(m,Number(traits[k]||0)));possible+=m;}
  return {score:Math.round((earned/possible)*maxScore*100)/100,feedback:parsed.feedback||"",traits,wordCount};
}

async function enrichAnswersWithScores(answers) {
  const safeAnswers = Array.isArray(answers) ? answers : [];

  const questions = readJson(QUESTIONS_FILE).map(normalizeQuestion);
  const questionMap = new Map(
    questions.map(q => [String(q.id), q])
  );

  const enriched = [];

  for (const answer of safeAnswers) {
    const question = questionMap.get(String(answer.questionId)) || {};
    const maxScore = Number(question.points || answer.maxScore || 10);

    let autoScore = 0;
    let aiFeedback = "";
    let aiDetails = null;
    let transcript = answer.transcript || "";

    if (answer.type === "speaking") {
      if (!transcript && answer.speakingAudio) transcript = await transcribeAudioFromUrl(answer.speakingAudio);
      const aiScore = await scoreSpeakingWithAI({ question, transcript, maxScore });
      autoScore = aiScore.score; aiFeedback = aiScore.feedback; aiDetails = aiScore;
    } else if (answer.type === "writing" || answer.subType === "summarize_spoken_text") {
      const aiScore = await scoreWritingWithAI({ question, responseText: answer.answer, maxScore });
      autoScore = aiScore.score; aiFeedback = aiScore.feedback; aiDetails = aiScore;
    } else {
      autoScore = calculateAutoScore(question, answer.answer);
    }

    enriched.push({
      ...answer,
      transcript,
      maxScore,
      autoScore,
      finalScore: autoScore,
      aiFeedback,
      aiDetails
    });
  }

  return enriched;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "index.html"));
});

app.get("/question-admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "question-admin.html"));
});

app.get("/exam-admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "exam-admin.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "admin.html"));
});

app.get("/exam.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "exam.html"));
});

app.get("/admin-login", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "admin-login.html"));
});

app.get("/admin-index", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "admin-index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "admin.html"));
});

app.get("/exam-admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "exam-admin.html"));
});

app.get("/question-admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "question-admin.html"));
});

const OFFICIAL_PTE_SUBTYPES = new Set([
  "read_aloud","repeat_sentence","describe_image","re_tell_lecture","answer_short_question",
  "summarize_group_discussion","respond_to_a_situation","summarize_written_text","essay",
  "reading_writing_fill_blanks","reading_mcq_multiple","reorder_paragraphs","reading_fill_blanks","reading_mcq_single",
  "summarize_spoken_text","listening_mcq_multiple","listening_fill_blanks","highlight_correct_summary",
  "listening_mcq_single","select_missing_word","highlight_incorrect_words","write_from_dictation"
]);

const PTE_SUBTYPE_SECTION = {
  read_aloud:"speaking", repeat_sentence:"speaking", describe_image:"speaking",
  re_tell_lecture:"speaking", answer_short_question:"speaking",
  summarize_group_discussion:"speaking", respond_to_a_situation:"speaking",
  summarize_written_text:"writing", essay:"writing",
  reading_writing_fill_blanks:"reading", reading_mcq_multiple:"reading",
  reorder_paragraphs:"reading", reading_fill_blanks:"reading", reading_mcq_single:"reading",
  summarize_spoken_text:"listening", listening_mcq_multiple:"listening",
  listening_fill_blanks:"listening", highlight_correct_summary:"listening",
  listening_mcq_single:"listening", select_missing_word:"listening",
  highlight_incorrect_words:"listening", write_from_dictation:"listening"
};

function isValidPteTypeSubtype(type, subType) {
  return PTE_SUBTYPE_SECTION[String(subType || "")] === String(type || "").toLowerCase();
}

function migrateQuestionForCurrentPte(question) {
  const q = normalizeQuestion(question);
  if (!OFFICIAL_PTE_SUBTYPES.has(q.subType) || !isValidPteTypeSubtype(q.type, q.subType)) return null;
  if (q.type === "reading" || q.type === "listening") q.time = 0;
  if (q.type !== "speaking") { q.prepareTime = 0; q.recordTime = 0; }
  if (q.subType === "read_aloud") { q.prepareTime = 35; q.recordTime = 40; }
  if (q.subType === "repeat_sentence") { q.prepareTime = 0; q.recordTime = 15; }
  if (q.subType === "describe_image") { q.prepareTime = 25; q.recordTime = 40; }
  if (q.subType === "re_tell_lecture") { q.prepareTime = 10; q.recordTime = 40; }
  if (q.subType === "answer_short_question") { q.prepareTime = 0; q.recordTime = 10; }
  if (q.subType === "summarize_group_discussion") { q.prepareTime = 10; q.recordTime = 120; }
  if (q.subType === "respond_to_a_situation") { q.prepareTime = 10; q.recordTime = 40; }
  if (q.subType === "reading_fill_blanks" || q.subType === "reading_writing_fill_blanks" || q.subType === "listening_fill_blanks") {
    q.textContent = String(q.textContent || "").replace(/_{3,}/g, "_______");
    if (!q.correctAnswers.length && q.correctAnswer) q.correctAnswers = String(q.correctAnswer).split(",").map(v => v.trim()).filter(Boolean);
    q.evaluationType = "correctAnswers";
  }
  return q;
}

app.get("/questions", (req, res) => {
  const questions = readJson(QUESTIONS_FILE);
  res.json(questions.map(migrateQuestionForCurrentPte).filter(Boolean));
});

app.post("/upload-audio", upload.single("audio"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required." });
    }

    const fileUrl = `/uploads/${req.file.filename}`;

    res.json({
      success: true,
      url: fileUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error("POST /upload-audio error:", error);
    res.status(500).json({ error: "Audio upload failed." });
  }
});

app.post("/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required." });
    }

    const fileUrl = `/uploads/${req.file.filename}`;

    res.json({
      success: true,
      url: fileUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error("POST /upload-image error:", error);
    res.status(500).json({ error: "Image upload failed." });
  }
});

app.post("/questions", (req, res) => {
  try {
    if (!req.body.type || !req.body.title) {
      return res.status(400).json({
        error: "Type and title are required."
      });
    }

    if (!OFFICIAL_PTE_SUBTYPES.has(String(req.body.subType || "")) ||
        !isValidPteTypeSubtype(req.body.type, req.body.subType)) {
      return res.status(400).json({ error: "PTE task type does not match its section." });
    }

    const newQuestion = migrateQuestionForCurrentPte({
      id: Date.now().toString(),
      type: req.body.type,
      subType: req.body.subType,
      title: req.body.title,
      prompt: req.body.prompt,
      points: req.body.points,

      time: req.body.time,
      prepareTime: req.body.prepareTime,
      recordTime: req.body.recordTime,

      audioUrl: req.body.audioUrl,
      imageUrl: req.body.imageUrl,
      textContent: req.body.textContent,

      options: req.body.options,

      evaluationType: req.body.evaluationType,
      keywords: req.body.keywords,
      answerKey: req.body.answerKey,
      correctAnswer: req.body.correctAnswer,
      correctAnswers: toAnswerArray(req.body.correctAnswers, "line").filter(Boolean),

      answer: req.body.answer
    });

    const questions = readJson(QUESTIONS_FILE);
    questions.push(newQuestion);
    writeJson(QUESTIONS_FILE, questions);

    res.status(201).json(newQuestion);
  } catch (error) {
    console.error("POST /questions error:", error);
    res.status(500).json({ error: "Question could not be saved." });
  }
});

app.put("/questions/:id", (req, res) => {
  try {
    const id = String(req.params.id);
    const questions = readJson(QUESTIONS_FILE);

    const index = questions.findIndex(q => String(q.id) === id);

    if (index === -1) {
      return res.status(404).json({ error: "Question not found." });
    }

    const requestedSubType = String(req.body.subType || questions[index].subType || "");
    const requestedType = String(req.body.type || questions[index].type || "").toLowerCase();
    if (!OFFICIAL_PTE_SUBTYPES.has(requestedSubType) ||
        !isValidPteTypeSubtype(requestedType, requestedSubType)) {
      return res.status(400).json({ error: "PTE task type does not match its section." });
    }

    const updatedQuestion = migrateQuestionForCurrentPte({
      ...questions[index],
      ...req.body,
      id
    });

    questions[index] = updatedQuestion;
    writeJson(QUESTIONS_FILE, questions);

    res.json(updatedQuestion);
  } catch (error) {
    console.error("PUT /questions/:id error:", error);
    res.status(500).json({ error: "Update failed" });
  }
});

app.delete("/questions/:id", (req, res) => {
  try {
    const id = String(req.params.id);
    const questions = readJson(QUESTIONS_FILE);

    const filtered = questions.filter(q => String(q.id) !== id);

    writeJson(QUESTIONS_FILE, filtered);

    res.json({ success: true });
  } catch (error) {
    console.error("DELETE /questions/:id error:", error);
    res.status(500).json({ error: "Delete failed" });
  }
});

app.post("/create-exam", async (req, res) => {
  try {
    const { title, questions } = req.body;

    if (!title || !questions || !questions.length) {
      return res.status(400).json({ error: "No questions selected" });
    }

    const allQuestions = readJson(QUESTIONS_FILE)
      .map(migrateQuestionForCurrentPte)
      .filter(Boolean);

    const selectedQuestions = questions
      .map(item => {
        const selectedId =
          typeof item === "object" && item !== null ? String(item.id || "") : String(item);
        return allQuestions.find(q => String(q.id) === selectedId);
      })
      .filter(Boolean);

    if (!selectedQuestions.length) {
      return res.status(400).json({ error: "Selected questions not found." });
    }

    const sectionOrder = {
      speaking: 1,
      writing: 1,
      reading: 2,
      listening: 3
    };

    const taskOrder = {
      read_aloud:1, repeat_sentence:2, describe_image:3, re_tell_lecture:4,
      answer_short_question:5, summarize_group_discussion:6, respond_to_a_situation:7,
      summarize_written_text:8, essay:9,
      reading_writing_fill_blanks:10, reading_mcq_multiple:11, reorder_paragraphs:12,
      reading_fill_blanks:13, reading_mcq_single:14,
      summarize_spoken_text:15, listening_mcq_multiple:16, listening_fill_blanks:17,
      highlight_correct_summary:18, listening_mcq_single:19, select_missing_word:20,
      highlight_incorrect_words:21, write_from_dictation:22
    };

    const sortedQuestions = selectedQuestions.sort((a, b) => {
      const orderA = sectionOrder[String(a.type || "").toLowerCase()] || 999;
      const orderB = sectionOrder[String(b.type || "").toLowerCase()] || 999;
      if (orderA !== orderB) return orderA - orderB;
      return (taskOrder[a.subType] || 999) - (taskOrder[b.subType] || 999);
    });

    const examCode = "EX" + Math.floor(100000 + Math.random() * 900000);

    const { error } = await supabase.from("exams").insert([
      {
        exam_code: examCode,
        title,
        questions: sortedQuestions,
        used: false,
        used_at: null
      }
    ]);

    if (error) {
      console.error("SUPABASE CREATE EXAM ERROR:", error);
      return res.status(500).json({ error: "Exam could not be created." });
    }

    res.json({
      success: true,
      examCode
    });

  } catch (error) {
    console.error("POST /create-exam error:", error);
    res.status(500).json({ error: "Exam could not be created." });
  }
});

app.get("/exams", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exams")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("SUPABASE GET EXAMS ERROR:", error);
      return res.status(500).json({ error: "Exams could not be loaded." });
    }

    const exams = (data || []).map(item => ({
      id: item.id,
      examCode: item.exam_code,
      title: item.title,
      questions: item.questions || [],
      createdAt: item.created_at,
      used: item.used,
      usedAt: item.used_at
    }));

    res.json(exams);

  } catch (error) {
    console.error("GET /exams error:", error);
    res.status(500).json({ error: "Exams could not be loaded." });
  }
});

app.get("/exams/code/:examCode", async (req, res) => {
  try {
    const examCode = String(req.params.examCode || "").trim().toUpperCase();

    const { data, error } = await supabase
      .from("exams")
      .select("*")
      .eq("exam_code", examCode)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Exam not found." });
    }

    if (data.used === true) {
      return res.status(400).json({
        error: "This exam code has already been used."
      });
    }

    const usedAt = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("exams")
      .update({
        used: true,
        used_at: usedAt
      })
      .eq("id", data.id)
      .select()
      .single();

    if (updateError) {
      console.error("SUPABASE UPDATE EXAM USED ERROR:", updateError);
      return res.status(500).json({ error: "Exam could not be loaded." });
    }

    res.json({
      id: updated.id,
      examCode: updated.exam_code,
      title: updated.title,
      questions: (updated.questions || []).map(migrateQuestionForCurrentPte).filter(Boolean),
      createdAt: updated.created_at,
      used: updated.used,
      usedAt: updated.used_at
    });

  } catch (error) {
    console.error("GET /exams/code/:examCode error:", error);
    res.status(500).json({ error: "Exam could not be loaded." });
  }
});

app.delete("/exams/:id", async (req, res) => {
  try {
    const id = String(req.params.id);

    const { data, error } = await supabase
      .from("exams")
      .delete()
      .eq("id", id)
      .select();

    if (error) {
      console.error("SUPABASE DELETE EXAM ERROR:", error);
      return res.status(500).json({ error: "Exam could not be deleted." });
    }

    res.json({
      success: true,
      deleted: data
    });

  } catch (error) {
    console.error("DELETE /exams/:id error:", error);
    res.status(500).json({ error: "Exam could not be deleted." });
  }
});

app.post("/save-exam", async (req, res) => {
  try {
    const body = req.body || {};

    const scoredAnswers = await enrichAnswersWithScores(body.answers);
    const calculatedSummary = buildSummary(scoredAnswers);

    let detailedEvaluation = await generateDetailedEvaluation(
      calculatedSummary,
      scoredAnswers
    );

    if (!detailedEvaluation) {
      detailedEvaluation = buildEvaluation(calculatedSummary);
    }

    const examData = normalizeExamResult({
      id: Date.now().toString(),
      candidateName: body.candidateName,
      candidateSurname: body.candidateSurname,
      candidatePhone: String(body.candidatePhone || "").replace(/\D/g, ""),
      candidateEmail: body.candidateEmail,
      candidateId: body.candidateId,
      examCode: body.examCode,
      startedAt: body.startedAt,
      finishedAt: body.finishedAt,
      answers: scoredAnswers,
      summary: calculatedSummary
    });
    const { error } = await supabase.from("exam_results").insert([
      {
        candidate_name: examData.candidateName,
        candidate_surname: examData.candidateSurname,
        candidate_phone: examData.candidatePhone,
        candidate_email: examData.candidateEmail,
        exam_code: examData.examCode,
        started_at: examData.startedAt,
        finished_at: examData.finishedAt,
        answers: examData.answers,
        summary: examData.summary,
        evaluation: detailedEvaluation
      }
    ]);

    if (error) {
      if (error.code === "23505") {
        console.log("DUPLICATE EXAM BLOCKED:", examData.examCode);

        return res.json({
          success: true,
          alreadySaved: true
        });
      }

      console.error("SUPABASE SAVE ERROR:", error);

      return res.status(500).json({
        error: "Exam could not be saved."
      });
    }

    res.json({ success: true });

    resend.emails.send({
      from: "PTE Exam <no-reply@mindiacademy.com>",
      to: process.env.NOTIFY_EMAIL,
      subject: "Yeni PTE sınavı tamamlandı",
      html: `
    <h2>Yeni sınav tamamlandı</h2>
    <p><b>Aday:</b> ${examData.candidateName || ""}</p>
    <p><b>Telefon:</b> ${examData.candidatePhone || ""}</p>
    <p><b>E-posta:</b> ${examData.candidateEmail || ""}</p>
    <p><b>Exam Code:</b> ${examData.examCode || ""}</p>
    <p><b>Finished At:</b> ${examData.finishedAt || ""}</p>
  `
    }).catch(error => {
      console.error("RESEND MAIL ERROR:", error);
    });

  } catch (error) {
    console.error("POST /save-exam error:", error);
    res.status(500).json({ error: "Exam could not be saved." });
  }
});

app.get("/exam-results", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exam_results")
      .select("*")
      .order("finished_at", { ascending: false });

    if (error) {
      console.error("SUPABASE GET ERROR:", error);
      return res.status(500).json({ error: "Exam results could not be loaded." });
    }

    const normalizedResults = (data || []).map(item => ({
      id: String(item.id),
      candidateName: item.candidate_name || "",
      candidateSurname: item.candidate_surname || "",
      candidatePhone: item.candidate_phone || "",
      candidateEmail: item.candidate_email || "",
      candidateId: item.candidate_phone || "",
      examCode: item.exam_code || "",
      startedAt: item.started_at,
      finishedAt: item.finished_at,
      answers: item.answers || [],
      summary: item.summary || {},
      evaluation: item.evaluation || null
    }));

    res.json(normalizedResults);

  } catch (error) {
    console.error("GET /exam-results error:", error);
    res.status(500).json({ error: "Exam results could not be loaded." });
  }
});

app.put("/exam-results/:resultId/manual-score", async (req, res) => {
  try {
    const resultId = String(req.params.resultId);
    const { questionId, manualScore } = req.body;

    const { data: exam, error: getError } = await supabase
      .from("exam_results")
      .select("*")
      .eq("id", resultId)
      .single();

    if (getError || !exam) {
      return res.status(404).json({ error: "Exam result not found." });
    }

    const answers = Array.isArray(exam.answers) ? exam.answers : [];

    const answerIndex = answers.findIndex(
      a => String(a.questionId) === String(questionId)
    );

    if (answerIndex === -1) {
      return res.status(404).json({ error: "Answer not found." });
    }

    const parsedManualScore =
      manualScore === null || manualScore === "" || manualScore === undefined
        ? null
        : Number(manualScore);

    if (parsedManualScore !== null && Number.isNaN(parsedManualScore)) {
      return res.status(400).json({ error: "Invalid score." });
    }

    answers[answerIndex] = {
      ...answers[answerIndex],
      manualScore: parsedManualScore,
      finalScore:
        parsedManualScore !== null
          ? parsedManualScore
          : Number(answers[answerIndex].autoScore || 0)
    };

    const summary = buildSummary(answers);

    // Manuel puan değiştiği için detaylı değerlendirmeyi de yeniden oluştur
    let evaluation = await generateDetailedEvaluation(summary, answers);

    // OpenAI herhangi bir nedenle cevap vermezse,
    // rapor yine boş kalmasın.
    if (!evaluation) {
      evaluation = buildEvaluation(summary);
    }

    const { error: updateError } = await supabase
      .from("exam_results")
      .update({
        answers,
        summary,
        evaluation
      })
      .eq("id", resultId);

    if (updateError) {
      return res.status(500).json({
        error: "Manual score could not be updated."
      });
    }

    res.json({
      success: true,
      updatedAnswer: answers[answerIndex],
      summary,
      evaluation
    });
  } catch (error) {
    console.error("PUT /exam-results/:resultId/manual-score error:", error);
    res.status(500).json({ error: "Manual score could not be updated." });
  }
});

app.delete("/exam-results/:id", async (req, res) => {
  try {
    const id = String(req.params.id);

    console.log("DELETE ID:", id);

    const { data, error } = await supabase
      .from("exam_results")
      .delete()
      .eq("id", id)
      .select();

    console.log("DELETE RESULT:", data);
    console.log("DELETE ERROR:", error);

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      success: true,
      deleted: data
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Delete failed"
    });
  }
});

app.post("/transcribe-speaking", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required." });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe"
    });

    return res.json({
      success: true,
      transcript: transcription.text || ""
    });

  } catch (error) {
    console.error("POST /transcribe-speaking error:", error);
    res.status(500).json({ error: "Transcription failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

