export class OneAtATime<K, V> {
  private promises: Map<K, Promise<V>> = new Map();
  constructor() {}

  async run(
    key: K,
    fn: () => Promise<V>,
    options: {
      onFirst?: () => void,
      onNotFirst?: () => void,
    } = {},
  ): Promise<V> {
    let promise = this.promises.get(key);
    if (!promise) {
      if (options.onFirst) {
        options.onFirst();
      }
      promise = fn();
      this.promises.set(key, promise);
      try {
        return await promise;
      } finally {
        this.promises.delete(key);
      }
    } else {
      if (options.onNotFirst) {
        options.onNotFirst();
      }
      return await promise;
    }
  }
}
