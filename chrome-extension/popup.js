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
  const loginService = document.getElementById("loginService");
  const loginAction = document.getElementById("loginAction");
  const btnApplyLogin = document.getElementById("btnApplyLogin");
  const savedLogins = { chatgpt: { saved: false, email: "" }, grok: { saved: false, email: "" } };

  function serviceName() {
    return loginService.value === "grok" ? "grok" : "chatgpt";
  }

  function serviceLabel(service) {
    return service === "grok" ? "Grok" : "ChatGPT";
  }

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

  function showLoginForm() {
    const service = serviceName();
    const saved = savedLogins[service] || { saved: false, email: "" };
    const action = loginAction.value;
    loginSaved.innerText = saved.saved && saved.email
      ? serviceLabel(service) + " saved for " + saved.email
      : serviceLabel(service) + " has no saved login.";
    const showEmail = action === "save" || action === "password";
    const showPassword = action === "save" || action === "password";
    loginEmail.style.display = showEmail ? "block" : "none";
    loginPassword.style.display = showPassword ? "block" : "none";
    if (action === "forget") {
      btnApplyLogin.innerText = "Forget login";
    } else if (action === "password") {
      btnApplyLogin.innerText = "Change password";
      loginPassword.placeholder = "New password";
      if (saved.email) loginEmail.value = saved.email;
    } else {
      btnApplyLogin.innerText = "Save login";
      loginPassword.placeholder = "Password";
    }
  }

  function loadLoginStatus(service) {
    chrome.runtime.sendMessage({ type: "GET_ACCOUNT_LOGIN_STATUS", service: service }, (resp) => {
      if (!resp || resp.service !== service) return;
      savedLogins[service] = { saved: !!resp.saved, email: resp.email || "" };
      if (serviceName() === service) showLoginForm();
    });
  }

  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (resp) updateUI(resp);
  });
  loadLoginStatus("chatgpt");
  loadLoginStatus("grok");
  showLoginForm();

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
    statusMessage.innerText = "Checking ChatGPT and Grok, then teaching the protocol.";
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

  loginService.addEventListener("change", () => {
    loginPassword.value = "";
    const saved = savedLogins[serviceName()];
    loginEmail.value = saved && saved.email ? saved.email : "";
    showLoginForm();
  });
  loginAction.addEventListener("change", () => {
    loginPassword.value = "";
    showLoginForm();
  });

  btnApplyLogin.addEventListener("click", () => {
    const service = serviceName();
    const label = serviceLabel(service);
    const action = loginAction.value;
    if (action === "forget") {
      chrome.runtime.sendMessage({ type: "FORGET_ACCOUNT_LOGIN", service: service }, (resp) => {
        if (resp && resp.ok) {
          savedLogins[service] = { saved: false, email: "" };
          loginEmail.value = "";
          loginPassword.value = "";
          showLoginForm();
          statusMessage.innerText = label + " login removed from this PC.";
        } else {
          statusMessage.innerText = (resp && resp.error) || "Could not remove the saved login.";
        }
      });
      return;
    }
    const saved = savedLogins[service] || { saved: false, email: "" };
    if (action === "password" && !saved.saved) {
      statusMessage.innerText = "Save a " + label + " login first. Then Change password can replace it.";
      return;
    }
    const email = loginEmail.value.trim();
    const password = loginPassword.value;
    if (!email || !password) {
      statusMessage.innerText = action === "password"
        ? "Enter the new " + label + " password."
        : "Enter the " + label + " email and password.";
      return;
    }
    statusMessage.innerText = action === "password"
      ? "Updating the " + label + " password..."
      : "Saving the " + label + " login on this PC...";
    chrome.runtime.sendMessage({ type: "SAVE_ACCOUNT_LOGIN", service: service, email: email, password: password }, (resp) => {
      loginPassword.value = "";
      if (resp && resp.ok && resp.saved && resp.service === service) {
        savedLogins[service] = { saved: true, email: resp.email || email };
        showLoginForm();
        statusMessage.innerText = action === "password"
          ? label + " password updated."
          : label + " login saved. Sidera will use it when that account is signed out.";
      } else {
        statusMessage.innerText = (resp && resp.error) || "Could not save the login.";
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
