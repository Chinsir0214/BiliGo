export async function enqueueSelectedItems(entries, makeRequest, startDownload, onQueued) {
  let queued = 0;
  for (const entry of entries) {
    let result;
    try {
      result = await startDownload(makeRequest(entry));
      if (!result?.id) throw new Error('下载队列未返回任务编号');
    } catch (error) {
      return { queued, remaining: entries.length - queued, error };
    }
    onQueued(entry, result);
    queued += 1;
  }
  return { queued, remaining: 0, error: null };
}
