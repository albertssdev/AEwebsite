/**
 * Ordered rule list — the first pattern that matches wins, so more specific
 * task types (image, current events) are checked before broad catch-alls.
 * Kept in sync with the Hive CLI's src/classifier.ts.
 */
const RULES = [
  {
    taskType: "image",
    reason: "mentions image generation/editing",
    patterns: [
      /\b(draw|generate|create|make|edit|design)\b.{0,30}\b(image|picture|photo|logo|illustration|artwork|graphic|icon)\b/i,
      /\b(image|picture|photo)\b.{0,20}\b(of|showing|depicting)\b/i,
      /\btext-to-image\b/i,
    ],
    fuzzyWords: ["photo", "picture", "image", "logo", "illustration", "artwork", "graphic", "icon"],
  },
  {
    taskType: "current_events",
    reason: "asks about current/real-time events",
    patterns: [
      /\b(latest|breaking|today'?s?|current|right now|just happened)\b.{0,20}\b(news|events?|headlines?)\b/i,
      /\bwho won\b/i,
      /\b(stock price|score|weather)\b.{0,15}\b(today|now|currently)\b/i,
      /\bwhat'?s happening\b/i,
    ],
    fuzzyWords: ["news", "headlines", "breaking"],
  },
  {
    taskType: "long_context",
    reason: "involves a very long document/codebase or video/audio analysis",
    patterns: [
      /\b(entire|whole|full)\b.{0,20}\b(codebase|repository|repo|document|book|transcript)\b/i,
      /\b(summarize|analyze|transcribe)\b.{0,20}\b(video|audio|recording|podcast)\b/i,
      /\b1m token|million.token\b/i,
    ],
    fuzzyWords: ["codebase", "repository", "transcript"],
  },
  {
    taskType: "coding",
    reason: "mentions code/programming",
    patterns: [
      /\b(function|bug|refactor|debug|script|algorithm|implement|compile|stack trace|regex|api endpoint|unit test)\b/i,
      /\b(python|typescript|javascript|java|rust|golang|c\+\+|sql)\b/i,
      /```/,
    ],
    fuzzyWords: ["function", "algorithm", "refactor", "debug"],
  },
  {
    taskType: "writing",
    reason: "requests long-form writing",
    patterns: [/\b(write|draft)\b.{0,20}\b(essay|article|blog post|story|chapter|novel|script)\b/i],
    fuzzyWords: ["essay", "article", "novel"],
  },
  {
    taskType: "agentic",
    reason: "multi-step or agentic task",
    patterns: [/\b(step[- ]by[- ]step|multi-step|plan out|agentic|autonomously|workflow)\b/i],
    fuzzyWords: ["agentic", "workflow"],
  },
  {
    taskType: "analysis",
    reason: "requests careful multi-step analysis",
    patterns: [/\b(analyze|analysis|reasoning|carefully consider|evaluate|compare and contrast)\b/i],
    fuzzyWords: ["analyze", "analysis", "evaluate"],
  },
  {
    taskType: "multimodal",
    reason: "involves voice/vision/multimodal input",
    patterns: [/\b(voice|vision|screenshot|attached image|listen to)\b/i],
    fuzzyWords: ["screenshot"],
  },
  {
    taskType: "brainstorming",
    reason: "brainstorming/idea generation",
    patterns: [/\b(brainstorm|ideas? for|suggest names|come up with)\b/i],
    fuzzyWords: ["brainstorm"],
  },
];

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Short words tolerate no typos (too many false-positive collisions); longer
// words allow one or two edits, which is enough to catch things like
// "pohoto" -> "photo" without matching unrelated short words by accident.
function maxEditDistance(anchorLength) {
  if (anchorLength <= 3) return 0;
  if (anchorLength <= 6) return 1;
  return 2;
}

function fuzzyClassify(query) {
  const words = query.toLowerCase().match(/[a-z]+/g) ?? [];

  for (const rule of RULES) {
    if (!rule.fuzzyWords) continue;
    for (const anchor of rule.fuzzyWords) {
      const maxDist = maxEditDistance(anchor.length);
      if (maxDist === 0) continue;

      for (const word of words) {
        if (Math.abs(word.length - anchor.length) > maxDist) continue;
        if (levenshtein(word, anchor) <= maxDist) {
          return { taskType: rule.taskType, reason: `${rule.reason} (typo-tolerant match on "${word}")` };
        }
      }
    }
  }

  return null;
}

export function classify(query) {
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(query))) {
      return { taskType: rule.taskType, reason: rule.reason };
    }
  }

  const fuzzy = fuzzyClassify(query);
  if (fuzzy) return fuzzy;

  return { taskType: "general", reason: "no specific signal matched — general-purpose query" };
}
