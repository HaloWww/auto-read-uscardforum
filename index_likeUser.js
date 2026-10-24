(function () {
  "use strict";
  if (window.__autoInjected) return;
  window.__autoInjected = true;

  function initialize() {
    const specific = true;
    const baseUrl = window.location.origin;
    const specificUser = localStorage.getItem("specificUser") || "halowang";
    const queueKey = specific ? "specificUserPostList" : "topicList";
    const likeLimit = specific ? 1 : 9;
    const resetAfter = specific ? 43200000 : 86400000;
    let clickCounter = Number(localStorage.getItem("clickCounter")) || 0;
    if (Date.now() - (Number(localStorage.getItem("clickCounterTimestamp")) || 0) > resetAfter) {
      clickCounter = 0;
      localStorage.setItem("clickCounter", "0");
      localStorage.setItem("clickCounterTimestamp", String(Date.now()));
    }
    const counters = { documents: 0, scrolls: 0, topicTransitions: 0, likeAttempts: 0 };
    try {
      const saved = JSON.parse(sessionStorage.getItem("autoReadCounters") || "null");
      for (const key of Object.keys(counters)) {
        if (Number.isSafeInteger(saved?.[key]) && saved[key] >= 0) counters[key] = saved[key];
      }
    } catch { /* A missing or corrupt snapshot must not stop reading. */ }
    function countActivity(key) {
      counters[key]++;
      // Keep each tab's totals through document navigations without relying on
      // browser console events, which the production transport can suppress.
      try { sessionStorage.setItem("autoReadCounters", JSON.stringify(counters)); } catch { /* Keep live counters. */ }
    }
    countActivity("documents");
    const status = window.__autoReadStatus = {
      started: true, startedAt: Date.now(), lastTickAt: Date.now(), phase: "reading", retryAt: 0, error: null, counters,
    };
    const emit = (type) => console.log("[auto-read]", JSON.stringify({ type }));
    const isReading = () => localStorage.getItem("read") === "true";
    const retryAt = () => Number(localStorage.getItem("autoReadRetryAfter")) || 0;
    const canLike = () => isReading() && Date.now() >= retryAt() &&
      localStorage.getItem("autoLikeEnabled") !== "false" && clickCounter < likeLimit;
    const considered = new WeakSet();
    const attempted = new Set();
    let opening = false;
    let bottomSince = null;
    let lastHeight = 0;
    let scrollSteps = 0;
    let nextLikeAt = 0;

    function readQueue() {
      try {
        const value = JSON.parse(localStorage.getItem(queueKey) || "[]");
        return Array.isArray(value) ? value : [];
      } catch { return []; }
    }

    function cooldown(until) {
      localStorage.setItem("autoReadRetryAfter", String(until));
      status.phase = "cooldown";
      status.retryAt = until;
    }

    async function requestTopicData(url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let retryAfter = 0;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" }, credentials: "same-origin", signal: controller.signal,
        });
        if (response.status === 429) {
          const value = response.headers.get("Retry-After");
          retryAfter = /^\d+$/.test(value || "")
            ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now()) || 0;
          localStorage.setItem("autoLikeEnabled", "false");
          localStorage.setItem("autoReadLikesPaused", "true");
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        localStorage.removeItem("autoReadFetchFailures");
        localStorage.removeItem("autoReadRetryAfter");
        return result;
      } catch (error) {
        const failures = Math.min(5, (Number(localStorage.getItem("autoReadFetchFailures")) || 0) + 1);
        const wait = Math.max(retryAfter, Math.min(900000, 60000 * 2 ** (failures - 1)));
        localStorage.setItem("autoReadFetchFailures", String(failures));
        cooldown(Date.now() + wait);
        console.warn(`读取帖子列表失败 (${error.message})，${Math.ceil(wait / 1000)} 秒后重试`);
        return null;
      } finally { clearTimeout(timeout); }
    }

    async function fillQueue() {
      const items = [];
      const seen = new Set();
      const firstPage = specific ? 1 : 0;
      const lastPage = specific ? 5 : 9;
      const limit = specific ? 100 : 200;
      const query = encodeURIComponent(`@${specificUser} order:latest`);
      for (let page = firstPage; page <= lastPage && items.length < limit; page++) {
        if (!isReading() || Date.now() < retryAt()) break;
        if (page > firstPage) await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!isReading() || Date.now() < retryAt()) break;
        const path = specific ? `/search?q=${query}&page=${page}` : `/latest.json?no_definitions=true&page=${page}`;
        const result = await requestTopicData(`${baseUrl}${path}`);
        const values = specific ? result?.posts : result?.topic_list?.topics;
        if (!Array.isArray(values) || values.length === 0) break;
        let added = 0;
        for (const item of values) {
          const key = specific ? `${item.topic_id}/${item.post_number}` : item.id;
          if (!key || (specific && (!item.topic_id || !item.post_number)) || seen.has(key)) continue;
          seen.add(key);
          added++;
          if (specific) items.push({ topic_id: item.topic_id, post_number: item.post_number });
          else if ((Number(item.posts_count) || 0) < 2000) items.push(item);
        }
        if (!added) break;
      }
      localStorage.setItem(queueKey, JSON.stringify(items.slice(0, limit)));
      return items.slice(0, limit);
    }

    async function openNext() {
      if (opening || !isReading() || Date.now() < retryAt()) return;
      opening = true;
      status.phase = "fetching";
      try {
        let items = readQueue();
        if (!items.length) items = await fillQueue();
        if (!isReading() || Date.now() < retryAt()) return;
        if (!items.length) { cooldown(Date.now() + 60000); return; }
        const item = items.shift();
        localStorage.setItem(queueKey, JSON.stringify(items));
        let path;
        if (specific) {
          localStorage.setItem("autoReadSpecificTarget", JSON.stringify(item));
          path = `/t/topic/${item.topic_id}/${item.post_number}`;
        } else {
          localStorage.setItem("justOpenedNewTopic", "true");
          path = `/t/topic/${item.id}${item.last_read_post_number ? `/${item.last_read_post_number}` : ""}`;
        }
        countActivity("topicTransitions");
        emit("topic");
        window.location.href = `${baseUrl}${path}`;
      } catch (error) {
        status.error = error.message;
        console.error("自动阅读跳转失败：", error.message);
        cooldown(Date.now() + 60000);
      } finally { opening = false; }
    }

    function specificButton() {
      let target;
      try { target = JSON.parse(localStorage.getItem("autoReadSpecificTarget") || "null"); } catch { return null; }
      // The seed topic can belong to somebody else. Only searched posts are
      // eligible, and post-number matching must not confuse #1 with #10.
      const parts = window.location.pathname.split("/").filter(Boolean);
      const topicId = Number(/^\d+$/.test(parts[1] || "") ? parts[1] : parts[2]);
      if (!target || topicId !== Number(target.topic_id)) return null;
      const number = Number(target.post_number);
      const article = document.querySelector?.(`#post_${number}, [data-post-number="${number}"]`);
      if (article) return article.querySelector(".discourse-reactions-reaction-button");
      const exact = new RegExp(`(?:^|\\s)#${number}(?!\\d)`);
      const anchor = Array.from(document.querySelectorAll("button[aria-label]")).find((button) =>
        exact.test(button.getAttribute("aria-label") || ""));
      return anchor?.parentElement.querySelector(".discourse-reactions-reaction-button") || null;
    }

    function scanLikes() {
      if (!canLike()) return;
      const buttons = specific ? [specificButton()].filter(Boolean)
        : Array.from(document.querySelectorAll(".discourse-reactions-reaction-button"));
      for (const button of buttons) {
        if (!canLike()) break;
        if (considered.has(button) || !["点赞此帖子", "Like this post"].includes(button.title)) continue;
        considered.add(button);
        if (!specific && Math.random() > 0.3) continue;
        const post = button.closest?.("article");
        const key = specific ? localStorage.getItem("autoReadSpecificTarget")
          : post?.getAttribute?.("data-post-id") || post?.id || null;
        if (key && attempted.has(key)) continue;
        const due = specific ? Date.now() : Math.max(Date.now() + 2000 + Math.floor(Math.random() * 3000), nextLikeAt);
        nextLikeAt = due + 2000;
        const dispatch = () => {
          if (!canLike() || button.isConnected === false || (key && attempted.has(key)) ||
              !["点赞此帖子", "Like this post"].includes(button.title)) return;
          if (key) attempted.add(key);
          countActivity("likeAttempts");
          emit("like-attempt");
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          clickCounter++;
          localStorage.setItem("clickCounter", String(clickCounter));
          if (clickCounter >= likeLimit) localStorage.setItem("autoLikeEnabled", "false");
        };
        if (due <= Date.now()) dispatch();
        else setTimeout(dispatch, due - Date.now());
      }
    }

    function tick() {
      status.lastTickAt = Date.now();
      status.retryAt = retryAt();
      status.phase = status.retryAt > Date.now() ? "cooldown" : opening ? "fetching" : "reading";
      try {
        if (!isReading() || status.phase === "cooldown" || opening) return;
        scanLikes();
        const before = window.scrollY;
        window.scrollBy(0, 200);
        if (window.scrollY !== before) {
          countActivity("scrolls");
          if (++scrollSteps === 1 || scrollSteps % 20 === 0) emit("scroll");
        }
        const height = Math.max(document.body?.offsetHeight || 0, document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0);
        const atBottom = window.innerHeight + window.scrollY >= height - 100;
        if (atBottom && height === lastHeight && window.scrollY === before) bottomSince ??= Date.now();
        else bottomSince = null;
        lastHeight = height;
        if (bottomSince !== null && Date.now() - bottomSince >= 3000) void openNext();
      } catch (error) {
        status.error = error.message;
        console.error("自动阅读循环失败：", error.message);
      } finally { setTimeout(tick, 1000); }
    }

    emit("started");
    tick();
  }

  // DOM readiness is enough. Ads or images can keep window.load pending forever.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
