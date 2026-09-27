document.addEventListener("DOMContentLoaded", () => {
  const stateBadge = document.getElementById("stateBadge");
  const turnCount = document.getElementById("turnCount");
  const lastMsgId = document.getElementById("lastMsgId");
  const ipcStatus = document.getElementById("ipcStatus");
  const modeStatus = document.getElementById("modeStatus");
  const lastError = document.getElementById("lastError");
  const statusMessage = document.getElementById("statusMessage");

  const btnPairLeft = document.getElementById("btnPairLeft");
  const btnPairRight = document.getElementById("btnPairRight");
  const btnStart = document.getElementById("btnStart");
  const btnPause = document.getElementById("btnPause");
  const btnStop = document.getElementById("btnStop");
  const btnForwardLR = document.getElementById("btnForwardLR");
  const btnForwardRL = document.getElementById("btnForwardRL");
  const maxTurnsInput = document.getElementById("maxTurns");
  const btnApplyMax = document.getElementById("btnApplyMax");
  const btnOpenData = document.getElementById("btnOpenData");
  const btnOpenLog = document.getElementById("btnOpenLog");
  const loginEmail = document.getElementById("loginEmail");
  const loginPassword = document.getElementById("loginPassword");
  const loginSaved = document.getElementById("loginSaved");
  const btnSaveLogin = document.getElementById("btnSaveLogin");
  const btnForgetLogin = document.getElementById("btnForgetLogin");

  let maxTurnsTouched = false;

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

    const turns = data.turnCount ?? 0;
    turnCount.innerText = data.maxTurns ? `${turns} / ${data.maxTurns}` : String(turns);
    lastMsgId.innerText = data.lastMessageId || "-";
    ipcStatus.innerText = data.connected ? "Connected" : "Not connected";
    modeStatus.innerText = data.autonomousSubmissions === false ? "Monitor only (no pasting)" : "Autonomous";

    if (data.lastError) {
      lastError.innerText = data.lastError;
      lastError.style.display = "block";
    } else {
      lastError.style.display = "none";
    }

    if (data.maxTurns && !maxTurnsTouched) maxTurnsInput.value = data.maxTurns;
    if (data.signInMessage) statusMessage.innerText = data.signInMessage;

    if (data.leftPaired) {
      btnPairLeft.classList.add("paired");
      btnPairLeft.innerText = "LEFT Paired ✓";
    }
    if (data.rightPaired) {
      btnPairRight.classList.add("paired");
      btnPairRight.innerText = "RIGHT Paired ✓";
    }

    if (state === "PAUSED" || state === "ERROR") {
      btnPause.innerText = "Resume";
      btnPause.classList.remove("btn-pause");
      btnPause.classList.add("btn-start");
    } else {
      btnPause.innerText = "Pause";
      btnPause.classList.add("btn-pause");
      btnPause.classList.remove("btn-start");
    }
  }

  function showSavedLogin(resp) {
    if (resp && resp.saved && resp.email) {
      loginSaved.innerText = "Saved for " + resp.email;
      loginEmail.value = resp.email;
      loginPassword.value = "";
      loginPassword.placeholder = "Saved — type a new password to replace it";
    } else {
      loginSaved.innerText = "";
      loginPassword.placeholder = "Password";
    }
  }

  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (resp) updateUI(resp);
  });
  chrome.runtime.sendMessage({ type: "GET_CHATGPT_LOGIN_STATUS" }, showSavedLogin);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "POPUP_STATUS_UPDATE") updateUI(msg);
  });

  btnPairLeft.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "PAIR_TAB", side: "LEFT" }, () => {
      btnPairLeft.classList.add("paired");
      btnPairLeft.innerText = "LEFT Paired ✓";
      statusMessage.innerText = "Paired the active tab as LEFT (ChatGPT).";
    });
  });

  btnPairRight.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "PAIR_TAB", side: "RIGHT" }, () => {
      btnPairRight.classList.add("paired");
      btnPairRight.innerText = "RIGHT Paired ✓";
      statusMessage.innerText = "Paired the active tab as RIGHT (Grok or Gemini).";
    });
  });

  btnStart.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "START", initial_hemisphere: "LEFT" }, (resp) => {
      if (resp && resp.ok === false) {
        statusMessage.innerText = resp.error || "Could not start.";
      }
    });
    statusMessage.innerText = "Checking ChatGPT, then teaching the protocol.";
  });

  btnPause.addEventListener("click", () => {
    if (btnPause.innerText === "Resume") {
      chrome.runtime.sendMessage({ type: "RESUME" });
      statusMessage.innerText = "Resuming the exchange.";
    } else {
      chrome.runtime.sendMessage({ type: "PAUSE" });
      statusMessage.innerText = "Pausing after the current turn.";
    }
  });

  btnStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP" });
    statusMessage.innerText = "Emergency STOP issued. Nothing more will be pasted.";
  });

  function forward(source, destination) {
    statusMessage.innerText = `Copying the latest ${source} reply to ${destination}...`;
    chrome.runtime.sendMessage({ type: "MANUAL_FORWARD", source: source }, (resp) => {
      if (resp && resp.ok) {
        statusMessage.innerText = `Forwarded ${resp.chars} characters ${source} → ${destination}.`;
      } else {
        statusMessage.innerText = `Manual forward failed: ${(resp && resp.error) || "unknown error"}`;
      }
    });
  }
  btnForwardLR.addEventListener("click", () => forward("LEFT", "RIGHT"));
  btnForwardRL.addEventListener("click", () => forward("RIGHT", "LEFT"));

  maxTurnsInput.addEventListener("input", () => {
    maxTurnsTouched = true;
  });
  btnApplyMax.addEventListener("click", () => {
    const value = parseInt(maxTurnsInput.value, 10);
    if (!Number.isFinite(value) || value < 1) {
      statusMessage.innerText = "Maximum turns must be a whole number of 1 or more.";
      return;
    }
    chrome.runtime.sendMessage({ type: "SET_MAX_TURNS", max_turns: value });
    maxTurnsTouched = false;
    statusMessage.innerText = `Maximum autonomous turns set to ${value}.`;
  });

  btnSaveLogin.addEventListener("click", () => {
    const email = loginEmail.value.trim();
    const password = loginPassword.value;
    if (!email || !password) {
      statusMessage.innerText = "Enter the ChatGPT email and password, then save.";
      return;
    }
    statusMessage.innerText = "Saving the ChatGPT login on this PC...";
    chrome.runtime.sendMessage({ type: "SAVE_CHATGPT_LOGIN", email: email, password: password }, (resp) => {
      loginPassword.value = "";
      if (resp && resp.ok && resp.saved) {
        showSavedLogin(resp);
        statusMessage.innerText = "ChatGPT login saved. Sidera will use it when that account is signed out.";
      } else {
        statusMessage.innerText = (resp && resp.error) || "Could not save the ChatGPT login.";
      }
    });
  });

  btnForgetLogin.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "FORGET_CHATGPT_LOGIN" }, (resp) => {
      if (resp && resp.ok) {
        loginEmail.value = "";
        loginPassword.value = "";
        showSavedLogin({ saved: false });
        statusMessage.innerText = "Saved ChatGPT login removed from this PC.";
      } else {
        statusMessage.innerText = (resp && resp.error) || "Could not remove the saved login.";
      }
    });
  });

  btnOpenData.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_DATA_FOLDER" });
    statusMessage.innerText = "Opening the Sidera data folder.";
  });
  btnOpenLog.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_LATEST_LOG" });
    statusMessage.innerText = "Opening the latest log file.";
  });
});
