(function () {
  "use strict";
  if (window.__autoInjected) return;
  window.__autoInjected = true;

  function initialize() {
    const baseUrl = window.location.origin;
    const commentLimit = 2000;
    const topicListLimit = 200;
    const likeLimit = 9;
    let scrollInterval = null;
    let checkScrollTimeout = null;
    let openingTopic = false;
    let clickCounter = Number(localStorage.getItem("clickCounter")) || 0;
    const now = Date.now();
    if (now - (Number(localStorage.getItem("clickCounterTimestamp")) || 0) > 86400000) {
      clickCounter = 0;
      localStorage.setItem("clickCounter", "0");
      localStorage.setItem("clickCounterTimestamp", String(now));
    }

    const isReading = () => localStorage.getItem("read") === "true";
    const canLike = () => isReading() && localStorage.getItem("autoLikeEnabled") !== "false" && clickCounter < likeLimit;
    const retryAt = () => Number(localStorage.getItem("autoReadRetryAfter")) || 0;

    async function requestTopicData(url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let retryAfter = 0;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (response.status === 429) {
          const value = response.headers.get("Retry-After");
          retryAfter = /^\d+$/.test(value || "")
            ? Number(value) * 1000
            : Math.max(0, Date.parse(value) - Date.now()) || 0;
          localStorage.setItem("autoLikeEnabled", "false");
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        localStorage.removeItem("autoReadFetchFailures");
        return result;
      } catch (error) {
        const failures = Math.min(5, (Number(localStorage.getItem("autoReadFetchFailures")) || 0) + 1);
        const wait = Math.max(retryAfter, Math.min(900000, 60000 * 2 ** (failures - 1)));
        localStorage.setItem("autoReadFetchFailures", String(failures));
        localStorage.setItem("autoReadRetryAfter", String(Date.now() + wait));
        console.warn(`读取帖子列表失败 (${error.message})，${Math.ceil(wait / 1000)} 秒后重试`);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function getLatestTopic() {
      const topicList = [];
      const seen = new Set();
      for (let page = 0; page < 10 && topicList.length < topicListLimit; page++) {
        if (!isReading()) break;
        if (page > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!isReading()) break;
        const result = await requestTopicData(`${baseUrl}/latest.json?no_definitions=true&page=${page}`);
        const topics = result?.topic_list?.topics;
        if (!Array.isArray(topics) || topics.length === 0) break;
        let newTopics = 0;
        for (const topic of topics) {
          if (!topic.id || seen.has(topic.id)) continue;
          seen.add(topic.id);
          newTopics++;
          if (commentLimit > topic.posts_count) topicList.push(topic);
        }
        if (newTopics === 0) break;
      }
      localStorage.setItem("topicList", JSON.stringify(topicList.slice(0, topicListLimit)));
    }

    async function openNewTopic() {
      if (openingTopic || !isReading()) return;
      openingTopic = true;
      try {
        let topicList = JSON.parse(localStorage.getItem("topicList") || "[]");
        if (topicList.length === 0 && Date.now() >= retryAt()) {
          await getLatestTopic();
          topicList = JSON.parse(localStorage.getItem("topicList") || "[]");
        }
        if (!isReading()) return;
        if (topicList.length > 0 && Date.now() >= retryAt()) {
          const topic = topicList.shift();
          localStorage.setItem("topicList", JSON.stringify(topicList));
          localStorage.setItem("justOpenedNewTopic", "true");
          const post = topic.last_read_post_number ? `/${topic.last_read_post_number}` : "";
          window.location.href = `${baseUrl}/t/topic/${topic.id}${post}`;
        } else {
          if (checkScrollTimeout !== null) clearTimeout(checkScrollTimeout);
          checkScrollTimeout = setTimeout(checkScroll, Math.max(60000, retryAt() - Date.now()));
        }
      } finally {
        openingTopic = false;
      }
    }

    async function checkScroll() {
      if (!isReading()) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 100) {
        await openNewTopic();
        return;
      }
      if (scrollInterval === null) {
        scrollInterval = setInterval(() => {
          if (isReading()) window.scrollBy(0, 20);
          else {
            clearInterval(scrollInterval);
            scrollInterval = null;
          }
        }, 100);
      }
      if (checkScrollTimeout !== null) clearTimeout(checkScrollTimeout);
      checkScrollTimeout = setTimeout(checkScroll, 2000);
    }

    function autoLike() {
      const buttons = document.querySelectorAll(".discourse-reactions-reaction-button");
      buttons.forEach((button, index) => {
        if (!canLike() || !["点赞此帖子", "Like this post"].includes(button.title) || Math.random() > 0.3) return;
        const delay = 2000 + Math.floor(Math.random() * 3000);
        setTimeout(() => {
          if (!canLike() || !["点赞此帖子", "Like this post"].includes(button.title)) return;
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          clickCounter++;
          localStorage.setItem("clickCounter", String(clickCounter));
          if (clickCounter >= likeLimit) localStorage.setItem("autoLikeEnabled", "false");
        }, index * delay);
      });
    }

    function startReading() {
      if (!isReading()) return;
      const start = () => {
        if (!isReading()) return;
        checkScroll();
        if (canLike()) autoLike();
      };
      if (localStorage.getItem("justOpenedNewTopic") === "true") {
        localStorage.removeItem("justOpenedNewTopic");
        setTimeout(start, 3000);
      } else start();
    }

    if (document.readyState === "complete") startReading();
    else window.addEventListener("load", startReading, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else initialize();
})();
