(function () {
  "use strict";
  if (window.__autoInjected) return;
  window.__autoInjected = true;

  function initialize() {
    const baseUrl = window.location.origin;
    const specificUser = localStorage.getItem("specificUser") || "halowang";
    const postListLimit = 100;
    const likeLimit = 1;
    let nextPostTimer = null;
    let openingPost = false;
    let clickCounter = Number(localStorage.getItem("clickCounter")) || 0;
    const now = Date.now();
    if (now - (Number(localStorage.getItem("clickCounterTimestamp")) || 0) > 43200000) {
      clickCounter = 0;
      localStorage.setItem("clickCounter", "0");
      localStorage.setItem("clickCounterTimestamp", String(now));
    }

    const isReading = () => localStorage.getItem("read") === "true";
    const canLike = () => isReading() && localStorage.getItem("autoLikeEnabled") !== "false";
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
      const posts = [];
      const seen = new Set();
      const query = encodeURIComponent(`@${specificUser} order:latest`);
      for (let page = 1; page <= 5 && posts.length < postListLimit; page++) {
        if (!isReading()) break;
        if (page > 1) await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!isReading()) break;
        const result = await requestTopicData(`${baseUrl}/search?q=${query}&page=${page}`);
        if (!Array.isArray(result?.posts) || result.posts.length === 0) break;
        let newPosts = 0;
        for (const post of result.posts) {
          const key = `${post.topic_id}/${post.post_number}`;
          if (!post.topic_id || !post.post_number || seen.has(key)) continue;
          seen.add(key);
          newPosts++;
          posts.push({ topic_id: post.topic_id, post_number: post.post_number });
        }
        if (newPosts === 0) break;
      }
      localStorage.setItem("specificUserPostList", JSON.stringify(posts.slice(0, postListLimit)));
    }

    async function openSpecificUserPost() {
      if (openingPost || !isReading()) return;
      openingPost = true;
      try {
        let posts = JSON.parse(localStorage.getItem("specificUserPostList") || "[]");
        if (posts.length === 0 && Date.now() >= retryAt()) {
          await getLatestTopic();
          posts = JSON.parse(localStorage.getItem("specificUserPostList") || "[]");
        }
        if (!isReading()) return;
        if (posts.length > 0 && Date.now() >= retryAt()) {
          const post = posts.shift();
          localStorage.setItem("specificUserPostList", JSON.stringify(posts));
          window.location.href = `${baseUrl}/t/topic/${post.topic_id}/${post.post_number}`;
        } else {
          if (nextPostTimer !== null) clearTimeout(nextPostTimer);
          nextPostTimer = setTimeout(openSpecificUserPost, Math.max(60000, retryAt() - Date.now()));
        }
      } finally {
        openingPost = false;
      }
    }

    function likeSpecificPost() {
      if (!canLike()) return;
      const lastPart = window.location.pathname.split("/").pop();
      let reactionButton;
      if (Number(lastPart) < 10000) {
        let target;
        document.querySelectorAll("button[aria-label]").forEach((button) => {
          if (button.getAttribute("aria-label")?.includes(`#${lastPart}`)) target = button;
        });
        reactionButton = target?.parentElement.querySelector(".discourse-reactions-reaction-button");
      } else {
        reactionButton = document.querySelectorAll(".discourse-reactions-reaction-button")[0];
      }
      if (!reactionButton || !["点赞此帖子", "Like this post"].includes(reactionButton.title)) return;
      if (clickCounter >= likeLimit) {
        localStorage.setItem("read", "false");
        return;
      }
      if (!canLike()) return;
      reactionButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      clickCounter++;
      localStorage.setItem("clickCounter", String(clickCounter));
      if (clickCounter >= likeLimit) localStorage.setItem("read", "false");
    }

    function startReading() {
      if (!isReading()) return;
      nextPostTimer = setTimeout(async () => {
        if (!isReading()) return;
        likeSpecificPost();
        if (isReading()) await openSpecificUserPost();
      }, 2000);
    }

    if (document.readyState === "complete") startReading();
    else window.addEventListener("load", startReading, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else initialize();
})();
