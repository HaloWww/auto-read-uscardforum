// ==UserScript==
// @name         Auto Read
// @namespace    http://tampermonkey.net/
// @version      1.4.6
// @description  自动刷linuxdo文章
// @author       liuweiqing
// @match        https://meta.discourse.org/*
// @match        https://linux.do/*
// @match        https://meta.appinn.net/*
// @match        https://community.openai.com/
// @match        https://idcflare.com/*
// @match        https://www.uscardforum.com/*
// @exclude      https://linux.do/a/9611/0
// @grant        none
// @license      MIT
// @icon         https://www.google.com/s2/favicons?domain=linux.do
// @downloadURL https://update.greasyfork.org/scripts/489464/Auto%20Read.user.js
// @updateURL https://update.greasyfork.org/scripts/489464/Auto%20Read.meta.js
// ==/UserScript==

(function () {
  "use strict";
  if (window.__autoInjected) return;
  window.__autoInjected = true;

  function initialize() {
  // 定义可能的基本URL
  const possibleBaseURLs = [
    "https://www.uscardforum.com",
    "https://linux.do",
    "https://meta.discourse.org",
    "https://meta.appinn.net",
    "https://community.openai.com",
    "https://idcflare.com",
  ];
  const commentLimit = 2000;
  const topicListLimit = 200;
  const likeLimit = 9;
  const delayBeforeBrowsingNewTopic = 3000; // 进入新帖子后延迟3秒再开始浏览（单位：毫秒），可根据需要调整
  // 获取当前页面的URL
  const currentURL = window.location.href;

  // 确定当前页面对应的BASE_URL
  let BASE_URL = possibleBaseURLs.find((url) => currentURL.startsWith(url));
  console.log("currentURL:", currentURL);
  // 环境变量：阅读网址，如果没有找到匹配的URL，则默认为第一个
  if (!BASE_URL) {
    BASE_URL = possibleBaseURLs[0];
    console.log("默认BASE_URL设置为: " + BASE_URL);
  } else {
    console.log("当前BASE_URL是: " + BASE_URL);
  }

  console.log("脚本正在运行在: " + BASE_URL);
  //1.进入网页 https://linux.do/t/topic/数字（1，2，3，4）
  //2.使滚轮均衡的往下移动模拟刷文章
  // 检查是否是第一次运行脚本
  function checkFirstRun() {
    if (localStorage.getItem("isFirstRun") === null) {
      console.log("脚本第一次运行，执行初始化操作...");
      updateInitialData();
      localStorage.setItem("isFirstRun", "false");
    } else {
      console.log("脚本非第一次运行");
    }
  }

  // 更新初始数据的函数
  function updateInitialData() {
    localStorage.setItem("read", "false"); // 开始时自动滚动关闭
    localStorage.setItem("autoLikeEnabled", "false"); //默认关闭自动点赞
    console.log("执行了初始数据更新操作");
  }
  const delay = 2000; // 滚动检查的间隔（毫秒）
  let scrollInterval = null;
  let checkScrollTimeout = null;
  let autoLikeInterval = null;

  function scrollToBottomSlowly(distancePerStep = 20, delayPerStep = 100) {
    if (scrollInterval !== null) {
      clearInterval(scrollInterval);
    }
    scrollInterval = setInterval(() => {
      window.scrollBy(0, distancePerStep);
    }, delayPerStep); // 每50毫秒滚动20像素
  }

  // Keep this helper self-contained: these files also run as standalone userscripts.
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
    // Yield between pages and stop even if the server repeats or filters every result.
    for (let page = 0; page < 10 && topicList.length < topicListLimit; page++) {
      if (localStorage.getItem("read") !== "true") break;
      if (page > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      if (localStorage.getItem("read") !== "true") break;
      const result = await requestTopicData(`${BASE_URL}/latest.json?no_definitions=true&page=${page}`);
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

  let openingTopic = false;
  async function openNewTopic() {
    if (openingTopic || localStorage.getItem("read") !== "true") return;
    openingTopic = true;
    try {
    let topicListStr = localStorage.getItem("topicList");
    let topicList = topicListStr ? JSON.parse(topicListStr) : [];

    // 如果列表为空，则获取最新文章
    if (topicList.length === 0) {
      if (Date.now() >= (Number(localStorage.getItem("autoReadRetryAfter")) || 0)) {
        await getLatestTopic();
      }
      topicListStr = localStorage.getItem("topicList");
      topicList = topicListStr ? JSON.parse(topicListStr) : [];
    }

    if (localStorage.getItem("read") !== "true") return;

    // 如果获取到新文章，打开第一个
    if (topicList.length > 0 && Date.now() >= (Number(localStorage.getItem("autoReadRetryAfter")) || 0)) {
      const topic = topicList.shift();
      localStorage.setItem("topicList", JSON.stringify(topicList));
      // 设置标志，表示刚进入新帖子，需要延迟后再开始浏览
      localStorage.setItem("justOpenedNewTopic", "true");
      if (topic.last_read_post_number) {
        window.location.href = `${BASE_URL}/t/topic/${topic.id}/${topic.last_read_post_number}`;
      } else {
        window.location.href = `${BASE_URL}/t/topic/${topic.id}`;
      }
    } else {
      const retryIn = Math.max(60000, (Number(localStorage.getItem("autoReadRetryAfter")) || 0) - Date.now());
      if (checkScrollTimeout !== null) clearTimeout(checkScrollTimeout);
      checkScrollTimeout = setTimeout(checkScroll, retryIn);
    }
    } finally {
      openingTopic = false;
    }
  }

  // 检查是否已滚动到底部(不断重复执行),到底部时跳转到下一个话题
  async function checkScroll() {
    if (localStorage.getItem("read") === "true") {
      if (
        window.innerHeight + window.scrollY >=
        document.body.offsetHeight - 100
      ) {
        console.log("已滚动到底部");
        await openNewTopic();
      } else {
        scrollToBottomSlowly();
        if (checkScrollTimeout !== null) {
          clearTimeout(checkScrollTimeout);
        }
        checkScrollTimeout = setTimeout(checkScroll, delay);
      }
    }
  }

  // 入口函数
  function startReading() {
    checkFirstRun();
    console.log(
      "autoRead",
      localStorage.getItem("read"),
      "autoLikeEnabled",
      localStorage.getItem("autoLikeEnabled")
    );
    if (localStorage.getItem("read") === "true") {
      // 检查是否刚进入新帖子
      if (localStorage.getItem("justOpenedNewTopic") === "true") {
        console.log(`延迟 ${delayBeforeBrowsingNewTopic / 1000} 秒后开始浏览新帖子...`);
        // 清除标志
        localStorage.removeItem("justOpenedNewTopic");
        // 延迟执行滚动和自动点赞
        setTimeout(() => {
          console.log("延迟时间到达，开始浏览");
          checkScroll();
          if (isAutoLikeEnabled()) {
            autoLike();
          }
        }, delayBeforeBrowsingNewTopic);
      } else {
        console.log("执行正常的滚动和检查逻辑");
        checkScroll();
        if (isAutoLikeEnabled()) {
          autoLike();
        }
      }
    }
  }

  // 获取当前时间戳
  const currentTime = Date.now();
  // 获取存储的时间戳
  const defaultTimestamp = new Date("1999-01-01T00:00:00Z").getTime(); //默认值为1999年
  const storedTime = parseInt(
    localStorage.getItem("clickCounterTimestamp") ||
      defaultTimestamp.toString(),
    10
  );

  // 获取当前的点击计数，如果不存在则初始化为0
  let clickCounter = parseInt(localStorage.getItem("clickCounter") || "0", 10);
  // 检查是否超过24小时（24小时 = 24 * 60 * 60 * 1000 毫秒）
  if (currentTime - storedTime > 24 * 60 * 60 * 1000) {
    // 超过24小时，清空点击计数器并更新时间戳
    clickCounter = 0;
    localStorage.setItem("clickCounter", "0");
    localStorage.setItem("clickCounterTimestamp", currentTime.toString());
  }

  console.log(`Initial clickCounter: ${clickCounter}`);
  function triggerClick(button) {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    button.dispatchEvent(event);
  }

  function autoLike() {
    console.log(`Initial clickCounter: ${clickCounter}`);
    // 寻找所有的discourse-reactions-reaction-button
    const buttons = document.querySelectorAll(
      ".discourse-reactions-reaction-button"
    );
    if (buttons.length === 0) {
      console.error(
        "No buttons found with the selector '.discourse-reactions-reaction-button'"
      );
      return;
    }
    console.log(`Found ${buttons.length} buttons.`); // 调试信息

    // 逐个点击找到的按钮
    buttons.forEach((button, index) => {
      if (
        (button.title !== "点赞此帖子" && button.title !== "Like this post") ||
        clickCounter >= likeLimit
      ) {
        return;
      }

      // 新增：点赞前加一个随机概率判断（如30%概率）
      const likeProbability = 0.3; // 0~1之间，0.3表示30%概率
      if (Math.random() > likeProbability) {
        console.log(`跳过第${index + 1}个按钮（未通过概率判断）`);
        return;
      }

      // 点赞间隔时间也随机（2~5秒之间）
      const randomDelay = 2000 + Math.floor(Math.random() * 3000);

      autoLikeInterval = setTimeout(() => {
        if (localStorage.getItem("read") !== "true" || !isAutoLikeEnabled() || clickCounter >= likeLimit) return;
        // 模拟点击
        triggerClick(button); // 使用自定义的触发点击方法
        console.log(`Clicked like button ${index + 1}`);
        clickCounter++; // 更新点击计数器
        // 将新的点击计数存储到localStorage
        localStorage.setItem("clickCounter", clickCounter.toString());
        // 如果点击次数达到likeLimit次，则设置点赞变量为false
        if (clickCounter === likeLimit) {
          console.log(
            `Reached ${likeLimit} likes, setting the like variable to false.`
          );
          localStorage.setItem("autoLikeEnabled", "false"); // 使用localStorage存储点赞变量状态
        } else {
          console.log("clickCounter:", clickCounter);
        }
      }, index * randomDelay); // 每次点赞的延迟为随机值
    });
  }
  const button = document.createElement("button");
  // 初始化按钮文本基于当前的阅读状态
  button.textContent =
    localStorage.getItem("read") === "true" ? "停止阅读" : "开始阅读";
  button.style.position = "fixed";
  button.style.bottom = "10px"; // 之前是 top
  button.style.left = "10px"; // 之前是 right
  button.style.zIndex = 1000;
  button.style.backgroundColor = "#f0f0f0"; // 浅灰色背景
  button.style.color = "#000"; // 黑色文本
  button.style.border = "1px solid #ddd"; // 浅灰色边框
  button.style.padding = "5px 10px"; // 内边距
  button.style.borderRadius = "5px"; // 圆角
  document.body.appendChild(button);

  button.onclick = function () {
    const currentlyReading = localStorage.getItem("read") === "true";
    const newReadState = !currentlyReading;
    localStorage.setItem("read", newReadState.toString());
    button.textContent = newReadState ? "停止阅读" : "开始阅读";
    if (!newReadState) {
      if (scrollInterval !== null) {
        clearInterval(scrollInterval);
        scrollInterval = null;
      }
      if (checkScrollTimeout !== null) {
        clearTimeout(checkScrollTimeout);
        checkScrollTimeout = null;
      }
      localStorage.removeItem("navigatingToNextTopic");
    } else {
      // 如果是Linuxdo，就导航到我的帖子
      if (BASE_URL == "https://linux.do") {
        window.location.href = "https://linux.do/t/topic/13716/900";
      } else {
        window.location.href = `${BASE_URL}/t/topic/1`;
      }
      checkScroll();
    }
  };

  //自动点赞按钮
  // 在页面上添加一个控制自动点赞的按钮
  const toggleAutoLikeButton = document.createElement("button");
  toggleAutoLikeButton.textContent = isAutoLikeEnabled()
    ? "禁用自动点赞"
    : "启用自动点赞";
  toggleAutoLikeButton.style.position = "fixed";
  toggleAutoLikeButton.style.bottom = "50px"; // 之前是 top，且与另一个按钮错开位置
  toggleAutoLikeButton.style.left = "10px"; // 之前是 right
  toggleAutoLikeButton.style.zIndex = "1000";
  toggleAutoLikeButton.style.backgroundColor = "#f0f0f0"; // 浅灰色背景
  toggleAutoLikeButton.style.color = "#000"; // 黑色文本
  toggleAutoLikeButton.style.border = "1px solid #ddd"; // 浅灰色边框
  toggleAutoLikeButton.style.padding = "5px 10px"; // 内边距
  toggleAutoLikeButton.style.borderRadius = "5px"; // 圆角
  document.body.appendChild(toggleAutoLikeButton);

  // 为按钮添加点击事件处理函数
  toggleAutoLikeButton.addEventListener("click", () => {
    const isEnabled = !isAutoLikeEnabled();
    setAutoLikeEnabled(isEnabled);
    toggleAutoLikeButton.textContent = isEnabled
      ? "禁用自动点赞"
      : "启用自动点赞";
  });
  // 判断是否启用自动点赞
  function isAutoLikeEnabled() {
    // 从localStorage获取autoLikeEnabled的值，如果未设置，默认为"true"
    return localStorage.getItem("autoLikeEnabled") !== "false";
  }

  // 设置自动点赞的启用状态
  function setAutoLikeEnabled(enabled) {
    localStorage.setItem("autoLikeEnabled", enabled ? "true" : "false");
  }

  if (document.readyState === "complete") startReading();
  else window.addEventListener("load", startReading, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
