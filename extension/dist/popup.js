"use strict";
(() => {
  // ../src/format.ts
  function formatUsd(cents) {
    const sign = cents < 0 ? "-" : "";
    const absolute = Math.abs(Math.round(cents));
    const dollars2 = Math.floor(absolute / 100);
    const remainder = absolute % 100;
    const grouped = dollars2.toLocaleString("en-US");
    if (remainder === 0) {
      return `${sign}$${grouped}`;
    }
    return `${sign}$${grouped}.${remainder.toString().padStart(2, "0")}`;
  }

  // ../src/glance.ts
  function lockGlance(items) {
    if (items.some((item) => item.status === "locked")) {
      return "Marinating";
    }
    if (items.some((item) => item.status === "vault")) {
      return "In the Vault";
    }
    return "Unlocked";
  }
  function oneLineVerdict(item, nowMs) {
    if (item.necessity === "necessary" && item.purchaseScore == null) {
      return "Necessary buy";
    }
    if (item.purchaseScore != null && item.scoreBucket === "strict" && item.status === "vault") {
      return `Score ${item.purchaseScore} \xB7 ${vaultLine(item.vaultUntil, nowMs)}`;
    }
    if (item.purchaseScore != null && item.scoreBucket === "soft" && item.status === "vault") {
      return `Score ${item.purchaseScore} \xB7 optional pause`;
    }
    if (item.purchaseScore != null && item.scoreBucket === "soft") {
      return `Score ${item.purchaseScore} \xB7 Sleep on it`;
    }
    if (item.purchaseScore != null && item.scoreBucket === "free") {
      return `Score ${item.purchaseScore} \xB7 Buy now`;
    }
    if (item.status === "vault") {
      return vaultLine(item.vaultUntil, nowMs);
    }
    if (item.userImpulseScore != null && item.purchaseScore == null && item.status === "locked") {
      return `Impulse ${item.userImpulseScore} \xB7 need a reason`;
    }
    if (item.status === "unlocked") {
      return "Buy now";
    }
    const decision = item.decision;
    if (!decision || decision.action === "unlock" || decision.savingsCents <= 0) {
      return "Buy now";
    }
    const months = decision.waitMonths > 0 ? decision.waitMonths : 1;
    return `Wait ~${months} mo, save ~${approxUsd(decision.savingsCents)}`;
  }
  function breakdownLines(item) {
    const decision = item.decision;
    const lines = [];
    appendScoreLines(item, lines);
    if (!decision) {
      if (lines.length === 0) {
        lines.push({ label: "Verdict", value: "No read yet" });
      }
      return lines;
    }
    const scored = item.scoreBucket === "soft" || item.scoreBucket === "strict";
    if (scored) {
      lines.push({ label: "Alternative", value: alternativeGlance(decision) });
    }
    const months = decision.waitMonths > 0 ? decision.waitMonths : 0;
    if (!scored) {
      lines.push({
        label: "Wait",
        value: decision.action === "sleep" && months > 0 ? `${months} months` : "Buy now"
      });
    }
    if (decision.action === "sleep" && decision.savingsCents > 0) {
      lines.push({ label: "Saved by waiting", value: formatUsd(decision.savingsCents) });
    }
    lines.push({
      label: "Trade-in",
      value: `${formatUsd(decision.tradeInNowCents)} now, ${formatUsd(decision.tradeInLaterCents)} later. Example data.`
    });
    lines.push({
      label: "Financing",
      value: `${formatUsd(decision.financingNowCents)} owed, ${formatUsd(decision.financingLaterCents)} later. Example data.`
    });
    if (!scored && decision.offerName && decision.savingsCents > 0 && decision.action === "sleep") {
      lines.push({
        label: "Example offer",
        value: `Waiting for the ${decision.offerName} saves ${formatUsd(decision.savingsCents)}. Example data, not a current carrier deal.`
      });
    }
    const sources = item.motiveSources;
    lines.push({
      label: "Need vs want",
      value: `${item.signals.needVsWant ?? "unknown"} (${sources?.needVsWant ?? "default"})`
    });
    lines.push({
      label: "Urgency",
      value: `${item.signals.urgency ?? "medium"} (${sources?.urgency ?? "default"})`
    });
    lines.push({
      label: "Phone broken",
      value: `${item.signals.currentPhoneBroken ? "yes" : "no"} (${sources?.currentPhoneBroken ?? "default"})`
    });
    if (item.signals.reasonText) {
      lines.push({ label: "Reason", value: `${item.signals.reasonText} (${sources?.reasonText ?? "default"})` });
    }
    lines.push({
      label: "Cost",
      value: decision.costLaterCents < 0 ? `${formatUsd(decision.costNowCents)} now. Waiting costs less by ${formatUsd(decision.savingsCents)}.` : `${formatUsd(decision.costNowCents)} now, ${formatUsd(decision.costLaterCents)} if you wait`
    });
    return lines;
  }
  function appendScoreLines(item, lines) {
    if (item.necessity) {
      const source = item.necessitySource ?? "keywords";
      const reason = item.necessityReason ? `. ${item.necessityReason}` : "";
      lines.push({ label: "Necessity", value: `${item.necessity} (${source})${reason}` });
    }
    if (item.userImpulseScore != null) {
      lines.push({ label: "Impulse", value: `${item.userImpulseScore} (mock history)` });
    }
    if (item.justificationGrade != null) {
      const signed = item.justificationGrade > 0 ? `+${item.justificationGrade}` : String(item.justificationGrade);
      const because = item.gradeReason ? `. ${item.gradeReason}` : "";
      lines.push({ label: "Grade", value: `${signed} (${item.gradeSource ?? "keywords"})${because}` });
    }
    if (item.purchaseScore != null && item.userImpulseScore != null && item.justificationGrade != null) {
      const signed = item.justificationGrade > 0 ? `+${item.justificationGrade}` : String(item.justificationGrade);
      lines.push({
        label: "Purchase score",
        value: `${item.purchaseScore} = ${item.userImpulseScore} + ${signed}`
      });
    }
    if (item.scoreBucket === "strict") {
      lines.push({ label: "Time limit", value: "24 hours, required. Demo: skip 24 hours lifts it." });
    } else if (item.scoreBucket === "soft") {
      lines.push({ label: "Time limit", value: "Optional. Sleep on it is not required." });
    } else if (item.scoreBucket === "free") {
      lines.push({ label: "Time limit", value: "None. The bag is unlocked." });
    }
  }
  function alternativeGlance(decision) {
    const months = decision.mathWaitMonths && decision.mathWaitMonths > 0 ? decision.mathWaitMonths : decision.waitMonths;
    const savings = decision.mathSavingsCents && decision.mathSavingsCents > 0 ? decision.mathSavingsCents : decision.savingsCents;
    if (decision.offerName && savings > 0) {
      const wait = months > 0 ? `${months} months` : "a while";
      return `Wait ${wait} for the ${decision.offerName}. Saves ${formatUsd(savings)}. Example data, not a current carrier deal.`;
    }
    if ((decision.mathAction === "sleep" || decision.action === "sleep") && savings > 0 && months > 0) {
      return `Wait ${months} months. Saves ${formatUsd(savings)}.`;
    }
    return "Waiting does not cost less than buying now.";
  }
  function vaultLine(vaultUntil, nowMs) {
    if (!vaultUntil) {
      return "Vault \xB7 24h left";
    }
    const left = Date.parse(vaultUntil) - nowMs;
    if (left <= 0) {
      return "Vault over";
    }
    const hours = Math.max(1, Math.ceil(left / 36e5));
    return `Vault \xB7 ${hours}h left`;
  }
  function approxUsd(cents) {
    const dollars2 = Math.max(0, Math.round(cents / 100));
    return `$${dollars2.toLocaleString("en-US")}`;
  }

  // src/popup.ts
  var state = document.getElementById("state");
  var list = document.getElementById("list");
  var empty = document.getElementById("empty");
  var openCode = null;
  chrome.storage.local.get(["simmerOrigin", "simmerUserId"], (stored) => {
    const origin = allowedOrigin(stored.simmerOrigin) ?? "http://127.0.0.1:4321";
    const userId = typeof stored.simmerUserId === "string" ? stored.simmerUserId : "";
    void load(origin, userId);
  });
  async function load(origin, userId) {
    const response = await fetch(`${origin}/api/carts`, { headers: { accept: "application/json" } });
    const body = await response.json();
    const carts = (body.carts ?? []).filter((cart) => !userId || cart.userId === userId);
    const items = carts.map(toGlance);
    if (state) {
      state.textContent = lockGlance(items);
    }
    if (!list || !empty) {
      return;
    }
    list.replaceChildren();
    empty.hidden = items.length > 0;
    for (const item of items) {
      list.append(card(item));
    }
  }
  function card(item) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card";
    button.setAttribute("aria-expanded", "false");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const price = document.createElement("span");
    price.textContent = ` \xB7 ${dollars(item.priceCents)}`;
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = oneLineVerdict(item, Date.now());
    button.append(title, price, line);
    const detail = document.createElement("div");
    detail.hidden = true;
    button.addEventListener("click", () => {
      const open = openCode === item.code;
      openCode = open ? null : item.code;
      detail.hidden = open;
      button.setAttribute("aria-expanded", open ? "false" : "true");
      if (!open) {
        detail.replaceChildren(breakdown(item));
      }
    });
    row.append(button, detail);
    return row;
  }
  function breakdown(item) {
    const dl = document.createElement("dl");
    for (const line of breakdownLines(item)) {
      const term = document.createElement("dt");
      term.textContent = line.label;
      const value = document.createElement("dd");
      value.textContent = line.value;
      dl.append(term, value);
    }
    return dl;
  }
  function toGlance(cart) {
    return {
      code: cart.code,
      name: cart.items[0]?.name ?? "Apple bag",
      priceCents: cart.totalCents,
      status: cart.status,
      vaultUntil: cart.vaultUntil,
      decision: cart.decision,
      signals: cart.signals ?? {},
      motiveSources: cart.motiveSources,
      necessity: cart.necessity ?? null,
      necessitySource: cart.necessitySource ?? null,
      necessityReason: cart.necessityReason ?? null,
      userImpulseScore: cart.userImpulseScore ?? null,
      justificationGrade: cart.justificationGrade ?? null,
      gradeSource: cart.gradeSource ?? null,
      gradeReason: cart.gradeReason ?? null,
      purchaseScore: cart.purchaseScore ?? null,
      scoreBucket: cart.scoreBucket ?? null,
      scoreReason: cart.scoreReason ?? null
    };
  }
  function dollars(cents) {
    const amount = Math.round(cents / 100);
    return `$${amount.toLocaleString("en-US")}`;
  }
  function allowedOrigin(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:") {
        return null;
      }
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }
})();
