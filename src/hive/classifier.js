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
  },
  {
    taskType: "long_context",
    reason: "involves a very long document/codebase or video/audio analysis",
    patterns: [
      /\b(entire|whole|full)\b.{0,20}\b(codebase|repository|repo|document|book|transcript)\b/i,
      /\b(summarize|analyze|transcribe)\b.{0,20}\b(video|audio|recording|podcast)\b/i,
      /\b1m token|million.token\b/i,
    ],
  },
  {
    taskType: "coding",
    reason: "mentions code/programming",
    patterns: [
      /\b(function|bug|refactor|debug|script|algorithm|implement|compile|stack trace|regex|api endpoint|unit test)\b/i,
      /\b(python|typescript|javascript|java|rust|golang|c\+\+|sql)\b/i,
      /```/,
    ],
  },
  {
    taskType: "writing",
    reason: "requests long-form writing",
    patterns: [/\b(write|draft)\b.{0,20}\b(essay|article|blog post|story|chapter|novel|script)\b/i],
  },
  {
    taskType: "agentic",
    reason: "multi-step or agentic task",
    patterns: [/\b(step[- ]by[- ]step|multi-step|plan out|agentic|autonomously|workflow)\b/i],
  },
  {
    taskType: "analysis",
    reason: "requests careful multi-step analysis",
    patterns: [/\b(analyze|analysis|reasoning|carefully consider|evaluate|compare and contrast)\b/i],
  },
  {
    taskType: "multimodal",
    reason: "involves voice/vision/multimodal input",
    patterns: [/\b(voice|vision|screenshot|attached image|listen to)\b/i],
  },
  {
    taskType: "brainstorming",
    reason: "brainstorming/idea generation",
    patterns: [/\b(brainstorm|ideas? for|suggest names|come up with)\b/i],
  },
];

export function classify(query) {
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(query))) {
      return { taskType: rule.taskType, reason: rule.reason };
    }
  }
  return { taskType: "general", reason: "no specific signal matched — general-purpose query" };
}
