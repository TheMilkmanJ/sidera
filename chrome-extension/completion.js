/**
 * Decides when an assistant bubble is a finished reply.
 * Grok shows "Worked for Ns / Ran N searches / Thinking" before the answer.
 * Those lines are not the reply the other hemisphere should receive.
 */
(function (root) {
  const STATUS_LINE = /^(?:working|thinking|searching(?:\.{3})?|searched)\b|^(?:worked for \d)|^(?:ran \d+ searches?)|^(?:\d+ sources?)$|^(?:search(?:ing)? the web\b)|^(?:opened page)$|^https?:\/\/\S+$|^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i;

  function statusLines(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function isInterimStatus(text) {
    const lines = statusLines(text);
    if (lines.some((line) => /^(?:working|thinking)\b/i.test(line))) return true;
    const suggestion = /^(?:analyze|explore|discuss|investigate|compare|show me|learn about|check)\b/i;
    if (lines.length > 0 && lines.every((line) => suggestion.test(line))) return true;
    const sourceLine = /^(?:the evidence|\+\d+|cited by:?.*)$|sciencedirect|taylor & francis|escholarship|doi\.org|springer|jstor/i;
    if (lines.length >= 3 && lines.filter((line) => sourceLine.test(line)).length / lines.length >= 0.6) return true;
    return lines.length === 0 || lines.every((line) => STATUS_LINE.test(line));
  }

  const SUGGESTION_LINE = /^(?:analyze|explore|discuss|investigate|compare|show me|learn about|check)\b/i;

  function finishedAnswer(text) {
    const lines = String(text || "").split(/\n/);
    const drop = (line) => {
      const trimmed = line.trim();
      return trimmed === "" || STATUS_LINE.test(trimmed) || SUGGESTION_LINE.test(trimmed);
    };
    while (lines.length && drop(lines[0])) lines.shift();
    while (lines.length && drop(lines[lines.length - 1])) lines.pop();
    return lines.join("\n").trim();
  }

  // Short canned messages the sites show when a request failed on their end.
  // These are not the other hemisphere's answer; the send should be retried.
  const ERROR_REPLY = /^(?:i'm having a hard time fulfilling your request|something went wrong|an error occurred|hmm\.{0,3}\s*something seems to have gone wrong|sorry, something went wrong|oops,? something went wrong|there was an error generating a response|a network error occurred|request timed out|too many requests)/i;

  function isErrorReply(text) {
    const trimmed = String(text || "").trim();
    return trimmed.length > 0 && trimmed.length < 400 && ERROR_REPLY.test(trimmed);
  }

  root.SideraCompletion = { isInterimStatus, finishedAnswer, isErrorReply };
})(typeof globalThis !== "undefined" ? globalThis : this);
