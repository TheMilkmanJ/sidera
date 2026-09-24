document.addEventListener("DOMContentLoaded", () => {
  const stateBadge = document.getElementById("stateBadge");
  const turnCount = document.getElementById("turnCount");
  const lastMsgId = document.getElementById("lastMsgId");
  const ipcStatus = document.getElementById("ipcStatus");
  const statusMessage = document.getElementById("statusMessage");

  const btnPairLeft = document.getElementById("btnPairLeft");
  const btnPairRight = document.getElementById("btnPairRight");
  const btnStart = document.getElementById("btnStart");
  const btnPause = document.getElementById("btnPause");
  const btnStop = document.getElementById("btnStop");

  function updateUI(data) {
    if (!data) return;
    const state = data.state || "IDLE";
    stateBadge.innerText = state;
    stateBadge.className = "badge";
    if (state.includes("WAIT") || state.includes("PROCESS") || state.includes("SEND")) {
      stateBadge.classList.add("active");
    } else if (state === "PAUSED") {
      stateBadge.classList.add("paused");
    } else if (state === "ERROR" || state === "DISCONNECTED") {
      stateBadge.classList.add("error");
    }

    turnCount.innerText = data.turnCount ?? 0;
    lastMsgId.innerText = data.lastMessageId || "-";
    ipcStatus.innerText = data.connected ? "Active" : "Disconnected";

    if (data.leftPaired) {
      btnPairLeft.classList.add("paired");
      btnPairLeft.innerText = "LEFT Paired ✓";
    }
    if (data.rightPaired) {
      btnPairRight.classList.add("paired");
      btnPairRight.innerText = "RIGHT Paired ✓";
    }

    if (state === "PAUSED") {
      btnPause.innerText = "Resume";
      btnPause.classList.remove("btn-pause");
      btnPause.classList.add("btn-start");
    } else {
      btnPause.innerText = "Pause";
      btnPause.classList.add("btn-pause");
      btnPause.classList.remove("btn-start");
    }
  }

  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (resp) updateUI(resp);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "POPUP_STATUS_UPDATE") updateUI(msg);
  });

  btnPairLeft.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "PAIR_TAB", side: "LEFT" }, (resp) => {
      btnPairLeft.classList.add("paired");
      btnPairLeft.innerText = "LEFT Paired ✓";
      statusMessage.innerText = "Paired active tab as LEFT (ChatGPT).";
    });
  });

  btnPairRight.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "PAIR_TAB", side: "RIGHT" }, (resp) => {
      btnPairRight.classList.add("paired");
      btnPairRight.innerText = "RIGHT Paired ✓";
      statusMessage.innerText = "Paired active tab as RIGHT (Gemini).";
    });
  });

  btnStart.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "START", initial_hemisphere: "LEFT" });
    statusMessage.innerText = "Autonomous exchange initiated.";
  });

  btnPause.addEventListener("click", () => {
    if (btnPause.innerText === "Resume") {
      chrome.runtime.sendMessage({ type: "RESUME" });
      statusMessage.innerText = "Resuming exchange.";
    } else {
      chrome.runtime.sendMessage({ type: "PAUSE" });
      statusMessage.innerText = "Pausing after current turn.";
    }
  });

  btnStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP" });
    statusMessage.innerText = "Emergency STOP issued.";
  });
});
