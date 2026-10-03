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
  const pairControls = {
    LEFT: { site: document.getElementById("siteLeft"), tab: document.getElementById("tabLeft"), button: btnPairLeft, open: document.getElementById("btnOpenLeft") },
    RIGHT: { site: document.getElementById("siteRight"), tab: document.getElementById("tabRight"), button: btnPairRight, open: document.getElementById("btnOpenRight") },
  };
  // Once the operator touches a side's site picker, status updates stop
  // overwriting it with the currently paired adapter.
  const siteTouched = { LEFT: false, RIGHT: false };
  let pairedTabs = { LEFT: null, RIGHT: null };
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

  // List the open tabs that belong to the side's chosen site, so the operator
  // can say which tab is LEFT and which is RIGHT even when both sides use the
  // same site. Tabs are labelled by window and chat title. The preselected tab
  // avoids the one the OTHER side is using, so two same-site pickers never
  // default to the same tab.
  function refreshTabChoices(side, preferredTabId) {
    const controls = pairControls[side];
    const other = SideraSites.otherSide(side);
    const adapterType = controls.site.value;
    const label = SideraSites.adapterLabel(adapterType);
    chrome.tabs.query({}, (tabs) => {
      const matching = (tabs || []).filter((tab) => SideraSites.siteForUrl(tab.url) === adapterType);
      const previous = parseInt(controls.tab.value, 10);
      controls.tab.innerHTML = "";
      if (matching.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.innerText = `No ${label} tab open`;
        controls.tab.appendChild(option);
        return;
      }
      // Stable window numbering across all open windows, in tab order.
      const windowNumbers = new Map();
      for (const tab of tabs) {
        if (!windowNumbers.has(tab.windowId)) windowNumbers.set(tab.windowId, windowNumbers.size + 1);
      }
      const multiWindow = new Set(matching.map((tab) => tab.windowId)).size > 1;
      for (const tab of matching) {
        const option = document.createElement("option");
        option.value = String(tab.id);
        const pairedAs = tab.id === pairedTabs.LEFT ? "LEFT" : tab.id === pairedTabs.RIGHT ? "RIGHT" : null;
        option.innerText = SideraSites.describeTab(tab, {
          windowNumber: windowNumbers.get(tab.windowId),
          multiWindow: multiWindow,
          pairedAs: pairedAs,
        });
        controls.tab.appendChild(option);
      }
      const otherSelection = parseInt(pairControls[other].tab.value, 10);
      const chosen = SideraSites.chooseTab(matching, {
        previousValue: Number.isFinite(preferredTabId) ? preferredTabId : (Number.isFinite(previous) ? previous : null),
        pairedTabId: pairedTabs[side],
        avoidTabIds: [pairedTabs[other], Number.isFinite(otherSelection) ? otherSelection : null],
      });
      if (chosen != null) controls.tab.value = String(chosen);
    });
  }

  function updateUI(data) {
    if (!data) return;
    const state = data.state || "IDLE";
    stateBadge.innerText = SideraSites.stateLabel(state);
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
    ipcStatus.innerText = data.connected ? "Running" : "Not running — open Sidera from its icon";
    modeStatus.innerText = data.autonomousSubmissions === false ? "Monitor only (no pasting)" : "Autonomous";

    if (data.lastError) {
      lastError.innerText = data.lastError;
      lastError.style.display = "block";
    } else {
      lastError.style.display = "none";
    }

    if (data.maxTurns && !maxTurnsTouched) maxTurnsInput.value = data.maxTurns;
    if (data.signInMessage) statusMessage.innerText = data.signInMessage;

    let pairingsChanged = false;
    for (const side of ["LEFT", "RIGHT"]) {
      const controls = pairControls[side];
      const slot = data.slots && data.slots[side];
      const paired = side === "LEFT" ? data.leftPaired : data.rightPaired;
      const tabId = slot && slot.tabId != null ? slot.tabId : null;
      if (pairedTabs[side] !== tabId) pairingsChanged = true;
      pairedTabs[side] = tabId;
      if (slot && slot.adapter && !siteTouched[side] && controls.site.value !== slot.adapter) {
        controls.site.value = slot.adapter;
        refreshTabChoices(side);
      }
      if (paired) {
        controls.button.classList.add("paired");
        controls.button.innerText = `${side} Paired ✓`;
      } else {
        // A closed or re-paired tab must not keep showing "Paired".
        controls.button.classList.remove("paired");
        controls.button.innerText = `Pair ${side}`;
      }
    }
    if (pairingsChanged) {
      refreshTabChoices("LEFT");
      refreshTabChoices("RIGHT");
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

  function pairSide(side) {
    const controls = pairControls[side];
    const adapterType = controls.site.value;
    const label = SideraSites.adapterLabel(adapterType);
    const tabId = parseInt(controls.tab.value, 10);
    if (!Number.isFinite(tabId)) {
      statusMessage.innerText = `Open a ${label} tab first, then pair it as ${side}.`;
      return;
    }
    const tabName = controls.tab.selectedOptions[0] ? controls.tab.selectedOptions[0].innerText : "the tab";
    chrome.runtime.sendMessage({ type: "PAIR_TAB", side: side, adapterType: adapterType, tabId: tabId }, (resp) => {
      if (!resp || resp.success === false) {
        statusMessage.innerText = (resp && resp.error) || `Could not pair ${side}.`;
        return;
      }
      controls.button.classList.add("paired");
      controls.button.innerText = `${side} Paired ✓`;
      statusMessage.innerText = `Paired ${tabName} as ${side} (${label}).`;
    });
  }

  btnPairLeft.addEventListener("click", () => pairSide("LEFT"));
  btnPairRight.addEventListener("click", () => pairSide("RIGHT"));

  // Open a fresh tab of the side's chosen site, in its own window so Chrome
  // does not throttle it as a hidden background tab, and preselect it in the
  // picker. Handy for same-AI runs, where a second tab is needed.
  function openTabFor(side) {
    const controls = pairControls[side];
    const adapterType = controls.site.value;
    const label = SideraSites.adapterLabel(adapterType);
    chrome.windows.create({ url: SideraSites.homeUrl(adapterType), focused: false }, (win) => {
      const newTab = win && win.tabs && win.tabs[0];
      statusMessage.innerText = `Opened a new ${label} window. Pick it under ${side}, then click Pair ${side}.`;
      setTimeout(() => refreshTabChoices(side, newTab ? newTab.id : undefined), 400);
    });
  }

  for (const side of ["LEFT", "RIGHT"]) {
    pairControls[side].open.addEventListener("click", () => openTabFor(side));
    pairControls[side].site.addEventListener("change", () => {
      siteTouched[side] = true;
      refreshTabChoices(side);
    });
  }
  refreshTabChoices("LEFT");
  refreshTabChoices("RIGHT");

  btnStart.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "START", initial_hemisphere: "LEFT" }, (resp) => {
      if (resp && resp.ok === false) {
        statusMessage.innerText = resp.error || "Could not start.";
      }
    });
    statusMessage.innerText = "Checking both sign-ins, then teaching the protocol.";
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
