/**
 * Shared DOM helpers for Sidera content adapters.
 * Loaded as a classic content script before the site adapters.
 */
(function (root) {
  function isVisible(el) {
    if (!el || el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryFirst(selectors, options) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const visibleOnly = !options || options.visible !== false;
    const enabledOnly = options && options.enabled;
    for (const sel of list) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      for (const node of nodes) {
        if (visibleOnly && !isVisible(node)) continue;
        if (enabledOnly && node.disabled) continue;
        return node;
      }
    }
    return null;
  }

  function queryLast(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      if (nodes.length > 0) return nodes[nodes.length - 1];
    }
    return null;
  }

  function setComposerText(el, text) {
    el.focus();
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "textarea" || tag === "input") {
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      return;
    }
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (err) {
      inserted = false;
    }
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    }
  }

  function clickControl(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }

  function pressEnter(el) {
    const base = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    for (const eventType of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(eventType, base));
    }
  }

  root.SideraDom = {
    isVisible: isVisible,
    queryFirst: queryFirst,
    queryLast: queryLast,
    setComposerText: setComposerText,
    clickControl: clickControl,
    pressEnter: pressEnter,
  };
})(globalThis);
