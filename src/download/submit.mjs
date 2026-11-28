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

export async function enqueueBatchItems(entries, makeRequest, startDownloads, onQueued) {
  if (entries.length === 0) return { queued: 0, remaining: 0, error: null };

  let tasks;
  try {
    const requests = entries.map(entry => makeRequest(entry));
    const result = await startDownloads(requests);
    tasks = result?.tasks;
    if (!Array.isArray(tasks) || tasks.length !== entries.length ||
        entries.some((_, index) => !tasks[index]?.id)) {
      throw new Error('下载队列未返回完整的任务编号');
    }
  } catch (error) {
    return { queued: 0, remaining: entries.length, error };
  }

  entries.forEach((entry, index) => onQueued(entry, tasks[index]));
  return { queued: entries.length, remaining: 0, error: null };
}
