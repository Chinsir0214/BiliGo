const { isAllowedBilibiliInputUrl } = require('../download/options');

const VIDEO_VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const VIDEO_SITE = 'https://www.bilibili.com';
const BVID = /^BV[a-zA-Z0-9]+$/;

function identifyVideo(url) {
  if (!isAllowedBilibiliInputUrl(url)) return null;
  const { pathname, searchParams } = new URL(url);
  const pathBvid = pathname.match(/\/(BV[a-zA-Z0-9]+)(?:\/|$)/)?.[1];
  if (pathBvid) return { bvid: pathBvid };
  const pathAid = pathname.match(/\/av(\d+)(?:\/|$)/i)?.[1];
  if (pathAid && /[1-9]/.test(pathAid)) return { aid: pathAid };
  const bvid = searchParams.get('bvid');
  if (BVID.test(bvid)) return { bvid };
  const aid = searchParams.get('aid');
  return /^\d+$/.test(aid) && /[1-9]/.test(aid) ? { aid } : null;
}

function requestedVideoPage(url) {
  if (!isAllowedBilibiliInputUrl(url)) throw new Error('视频链接无效');
  const pageValues = [...new URL(url).searchParams]
    .filter(([name]) => name.toLowerCase() === 'p')
    .map(([, value]) => value);
  if (!pageValues.length) return null;
  const page = Number(pageValues[0]);
  if (pageValues.length !== 1 || !/^\d+$/.test(pageValues[0]) || !Number.isSafeInteger(page) || page < 1) {
    throw new Error('视频分 P 编号无效');
  }
  return page;
}

async function fetchVideoInfo(video, { requestJson, cookieHeader, signal }) {
  const query = new URLSearchParams(video);
  const url = `${VIDEO_VIEW_URL}?${query}`;
  const cookie = cookieHeader(url);
  const headers = { Referer: VIDEO_SITE + '/' };
  if (cookie) headers.Cookie = cookie;
  const result = await requestJson(url, headers, { signal });
  if (result?.code !== 0 || !result.data) {
    const error = new Error(result?.message || '无法读取视频信息');
    error.apiCode = result?.code;
    throw error;
  }
  return result.data;
}

function validCid(cid) {
  return (typeof cid === 'string' || Number.isSafeInteger(cid)) && /^[1-9]\d*$/.test(cid) ? cid : null;
}

function videoPages(data) {
  if (!data.pages?.length) return [{ number: 1, cid: validCid(data.cid) }];
  const seen = new Set();
  return data.pages.map((page, index) => {
    if (!page || typeof page !== 'object') throw new Error('视频分 P 信息无效');
    const number = page.page == null ? index + 1 : Number(page.page);
    if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) {
      throw new Error('视频分 P 信息无效');
    }
    seen.add(number);
    const cid = validCid(page.cid) || (number === 1 ? validCid(data.cid) : null);
    return { number, cid, part: page.part, duration: page.duration };
  });
}

function selectVideoPage(pages, pageNumber) {
  const page = pages.find(item => item.number === pageNumber);
  if (!page) throw new Error(`视频没有第 ${pageNumber} P`);
  return page;
}

module.exports = { identifyVideo, requestedVideoPage, fetchVideoInfo, videoPages, selectVideoPage };
