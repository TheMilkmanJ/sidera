/**
 * Decides when an assistant bubble is a finished reply.
 * Grok shows "Worked for Ns / Ran N searches / Thinking" before the answer.
 * Those lines are not the reply the other hemisphere should receive.
 */
(function (root) {
  const STATUS_LINE = /^(?:working|thinking|searching(?:\.{3})?|searched)\b|^(?:worked for \d)|^(?:ran \d+ searches?)|^(?:\d+ sources?)$|^(?:search(?:ing)? the web\b)/i;

  function statusLines(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function isInterimStatus(text) {
    const lines = statusLines(text);
    return lines.length === 0 || lines.every((line) => STATUS_LINE.test(line));
  }

  function finishedAnswer(text) {
    const lines = String(text || "").split(/\n/);
    while (lines.length && (lines[0].trim() === "" || STATUS_LINE.test(lines[0].trim()))) lines.shift();
    while (lines.length && (lines[lines.length - 1].trim() === "" || STATUS_LINE.test(lines[lines.length - 1].trim()))) {
      lines.pop();
    }
    return lines.join("\n").trim();
  }

  root.SideraCompletion = { isInterimStatus, finishedAnswer };
})(typeof globalThis !== "undefined" ? globalThis : this);
