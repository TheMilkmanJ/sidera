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
    const suggestion = /^(?:analyze|explore|discuss|investigate|compare|show me|learn about)\b/i;
    if (lines.length > 0 && lines.every((line) => suggestion.test(line))) return true;
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

  root.SideraCompletion = { isInterimStatus, finishedAnswer };
})(typeof globalThis !== "undefined" ? globalThis : this);
