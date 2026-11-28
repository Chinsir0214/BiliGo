export function createSubscriptions(api) {
  const subscriptions = new Set();

  function on(channel, callback) {
    const unsubscribe = api.on(channel, callback);
    function stop() {
      if (subscriptions.delete(stop)) unsubscribe?.();
    }
    subscriptions.add(stop);
    return stop;
  }

  function dispose() {
    for (const stop of subscriptions) stop();
  }

  return { on, dispose };
}
