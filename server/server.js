const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");
const fs = require("fs")
const path = require("path");
const multer = require("multer");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3001;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
const SKILL_WEIGHTS = {
  read_aloud: { speaking: 0.7, reading: 0.3 },
  repeat_sentence: { speaking: 0.7, listening: 0.3 },
  describe_image: { speaking: 1.0 },
  re_tell_lecture: { speaking: 0.7, listening: 0.3 },
  answer_short_question: { listening: 0.6, speaking: 0.4 },

  summarize_group_discussion: { writing: 0.7, reading: 0.3 },
  respond_to_a_situation: { writing: 0.7, reading: 0.3 },
  summarize_written_text: { writing: 0.7, reading: 0.3 },
  essay: { writing: 1.0 },

  reading_writing_fill_blanks: { reading: 0.5, writing: 0.5 },
  reading_mcq_multiple: { reading: 1.0 },
  reading_mcq_group: { reading: 1.0 },
  reorder_paragraphs: { reading: 1.0 },
  reading_fill_blanks: { reading: 1.0 },
  reading_mcq_single: { reading: 1.0 },
  reading_word_formation: { reading: 0.7, writing: 0.3 },
  reading_word_formation_multi: { reading: 0.7, writing: 0.3 },
  reading_word_formation_passage: { reading: 0.7, writing: 0.3 },
  reading_short_answer_multi: { reading: 0.8, writing: 0.2 },

  summarize_spoken_text: { listening: 0.4, writing: 0.6 },
  listening_mcq_multiple: { listening: 1.0 },
  listening_fill_blanks: { listening: 1.0 },
  highlight_correct_summary: { listening: 0.7, reading: 0.3 },
  listening_mcq_single: { listening: 1.0 },
  select_missing_word: { listening: 1.0 },
  highlight_incorrect_words: { listening: 0.8, reading: 0.2 },
  write_from_dictation: { listening: 0.7, writing: 0.3 },
  listening_short_answer: { listening: 0.8, writing: 0.2 },
  listening_short_answer_multi: { listening: 0.8, writing: 0.2 },
  listening_sequence: { listening: 1.0 }
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

function calculateAutoScore(question, submittedAnswer) {
  const maxScore = Number(question.points || 10);
  const subType = question.subType || "";

  if (
    subType === "reading_mcq_single" ||
    subType === "listening_mcq_single" ||
    subType === "highlight_correct_summary" ||
    subType === "select_missing_word"
  ) {
    return scoreSingleChoice(
      submittedAnswer,
      question.correctAnswer || question.answer,
      maxScore
    );
  }

  if (
    subType === "reading_mcq_multiple" ||
    subType === "listening_mcq_multiple"
  ) {
    const correctAnswers = Array.isArray(question.correctAnswers) && question.correctAnswers.length
      ? question.correctAnswers
      : Array.isArray(question.answer)
        ? question.answer
        : toAnswerArray(question.answer || question.answerKey || "", "line").filter(Boolean);

    return scoreMultipleChoice(submittedAnswer, correctAnswers, maxScore);
  }

  if (subType === "reading_mcq_group") {
    const userArray = toAnswerArray(submittedAnswer, "line");

    const correctArray =
      Array.isArray(question.correctAnswers) && question.correctAnswers.length
        ? question.correctAnswers
        : toAnswerArray(question.answerKey || question.answer || "", "line");

    return scoreArrayAnswers(userArray, correctArray, maxScore, "line");
  }

  if (
    subType === "reading_fill_blanks" ||
    subType === "reading_writing_fill_blanks" ||
    subType === "reading_short_answer_multi" ||
    subType === "reading_word_formation" ||
    subType === "reading_word_formation_multi" ||
    subType === "reading_word_formation_passage" ||
    subType === "listening_short_answer_multi"
  ) {
    console.log("ARRAY BLOCK HIT:", subType);
    console.log("QUESTION ANSWER FIELD:", question.answer);
    console.log("SUBMITTED ANSWER FIELD:", submittedAnswer);

    const userArray = toAnswerArray(submittedAnswer, "line");
    const correctArray = toAnswerArray(question.answer || question.answerKey || "", "line");

    console.log("USER ARRAY AFTER SPLIT:", userArray);
    console.log("CORRECT ARRAY AFTER SPLIT:", correctArray);

    return scoreArrayAnswers(userArray, correctArray, maxScore, "line");
  }

  if (
    subType === "reorder_paragraphs" ||
    subType === "listening_sequence"
  ) {
    console.log("ARRAY BLOCK HIT:", subType);
    console.log("QUESTION ANSWER FIELD:", question.answer || question.answerKey);
    console.log("SUBMITTED ANSWER FIELD:", submittedAnswer);

    const userArray = toAnswerArray(submittedAnswer, "line");
    const correctArray = toAnswerArray(question.answer || question.answerKey || "", "comma");

    console.log("USER ARRAY AFTER SPLIT:", userArray);
    console.log("CORRECT ARRAY AFTER SPLIT:", correctArray);

    return scoreArrayAnswers(userArray, correctArray, maxScore, "line");
  }

  if (
    subType === "listening_fill_blanks" ||
    subType === "highlight_incorrect_words" ||
    subType === "write_from_dictation" ||
    subType === "listening_short_answer"
  ) {
    return scoreTextAnswer(
      submittedAnswer,
      question.answer || question.answerKey || "",
      maxScore
    );
  }

  if (
    question.type === "writing" ||
    question.type === "speaking" ||
    subType === "summarize_spoken_text"
  ) {
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

    time: Number(q.time || 60),
    prepareTime: Number(q.prepareTime || 25),
    recordTime: Number(q.recordTime || 40),

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

  const overallScore = Math.round(
    (speakingScore + writingScore + readingScore + listeningScore) / 4
  );

  return {
    overall: overallScore,
    speaking: speakingScore,
    writing: writingScore,
    reading: readingScore,
    listening: listeningScore
  };
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
    return {
      score: 0,
      feedback: "No speaking response detected.",
      fluency: 0,
      pronunciation: 0,
      content: 0
    };
  }

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: `
You are scoring a PTE-style speaking response.

Question type: ${question.subType || question.type || "speaking"}
Question title: ${question.title || ""}
Prompt: ${question.prompt || ""}
Question content: ${question.textContent || ""}

Candidate transcript:
${transcript}

Score the response from 0 to ${maxScore}.

Return ONLY valid JSON in this exact format:
{
  "score": number,
  "fluency": number,
  "pronunciation": number,
  "content": number,
  "feedback": "short explanation"
}

Rules:
- score must be between 0 and ${maxScore}
- fluency, pronunciation and content must be between 0 and 10
- be strict but fair
- if the answer is unrelated, score low
- if transcript is empty or meaningless, score 0
`
  });

  const rawText = response.output_text || "";
  const parsed = safeJsonParse(rawText);

  if (!parsed) {
    return {
      score: 0,
      feedback: "AI scoring failed.",
      fluency: 0,
      pronunciation: 0,
      content: 0
    };
  }

  const score = Math.max(0, Math.min(Number(maxScore), Number(parsed.score || 0)));

  return {
    score,
    fluency: Number(parsed.fluency || 0),
    pronunciation: Number(parsed.pronunciation || 0),
    content: Number(parsed.content || 0),
    feedback: parsed.feedback || ""
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
      if (!transcript && answer.speakingAudio) {
        transcript = await transcribeAudioFromUrl(answer.speakingAudio);
      }

      const aiScore = await scoreSpeakingWithAI({
        question,
        transcript,
        maxScore
      });

      autoScore = aiScore.score;
      aiFeedback = aiScore.feedback;
      aiDetails = aiScore;
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

app.get("/questions", (req, res) => {
  const questions = readJson(QUESTIONS_FILE);
  const normalized = questions.map(normalizeQuestion);
  res.json(normalized);
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

    const newQuestion = normalizeQuestion({
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

    const updatedQuestion = normalizeQuestion({
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

    const allQuestions = readJson(QUESTIONS_FILE).map(normalizeQuestion);

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
      writing: 2,
      reading: 3,
      listening: 4
    };

    const sortedQuestions = selectedQuestions.sort((a, b) => {
      const orderA = sectionOrder[String(a.type || "").toLowerCase()] || 999;
      const orderB = sectionOrder[String(b.type || "").toLowerCase()] || 999;
      return orderA - orderB;
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
      questions: updated.questions || [],
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
        summary: examData.summary
      }
    ]);

    if (error) {
      console.error("SUPABASE SAVE ERROR:", error);
      return res.status(500).json({ error: "Exam could not be saved." });
    }

    res.json({ success: true });

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
      summary: item.summary || {}
    }));

    res.json(normalizedResults);

  } catch (error) {
    console.error("GET /exam-results error:", error);
    res.status(500).json({ error: "Exam results could not be loaded." });
  }
});

app.put("/exam-results/:resultId/manual-score", (req, res) => {
  try {
    const resultId = String(req.params.resultId);
    const { questionId, manualScore } = req.body;

    const examResults = readJson(EXAM_RESULTS_FILE);
    const examIndex = examResults.findIndex(exam => String(exam.id) === resultId);

    if (examIndex === -1) {
      return res.status(404).json({ error: "Exam result not found." });
    }

    const exam = examResults[examIndex];

    if (!Array.isArray(exam.answers)) {
      return res.status(400).json({ error: "Answers not found." });
    }

    const answerIndex = exam.answers.findIndex(a => String(a.questionId) === String(questionId));

    if (answerIndex === -1) {
      return res.status(404).json({ error: "Answer not found." });
    }

    const answer = exam.answers[answerIndex];
    const parsedManualScore =
      manualScore === null || manualScore === "" || manualScore === undefined
        ? null
        : Number(manualScore);

    if (parsedManualScore !== null && Number.isNaN(parsedManualScore)) {
      return res.status(400).json({ error: "Invalid score." });
    }

    exam.answers[answerIndex] = {
      ...answer,
      manualScore: parsedManualScore,
      finalScore:
        parsedManualScore !== null && !Number.isNaN(parsedManualScore)
          ? parsedManualScore
          : Number(answer.autoScore || 0)
    };

    exam.summary = buildSummary(exam.answers);

    examResults[examIndex] = exam;
    writeJson(EXAM_RESULTS_FILE, examResults);

    res.json({
      success: true,
      updatedAnswer: exam.answers[answerIndex],
      summary: exam.summary
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

