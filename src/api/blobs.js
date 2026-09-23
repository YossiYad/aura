(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    fetchImageBlob: { get: () => fetchImageBlob },
    fetchStreamBlob: { get: () => fetchStreamBlob }
  });

  // A download was given a flat 45 seconds and then aborted, however well it was going.
  // A long track, a slow train, a phone on one bar - all of them hit that ceiling while
  // the bytes were still arriving, which is a download that "just does not work". What
  // matters is whether data is still coming, so the clock is a stall clock: it only fires
  // when nothing has arrived for a while.
  const STALL_MS = 25000;

  // Cover art lives on a remote host, so with no network a downloaded song shows an empty
  // square. Fetching the picture and keeping it beside the audio is what makes a saved
  // song look saved. Some hosts refuse cross-origin reads, hence the same proxy ladder
  // the audio uses.
  /**
   * @param {string} url
   * @returns {Promise<Blob>}
   */
  async function fetchImageBlob(url) {
    const get = async u => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(u, { signal: ctl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        if (blob.size < 500) throw new Error("too small");
        if (!/^image\//.test(blob.type)) return new Blob([blob], { type: "image/jpeg" });
        return blob;
      } finally { clearTimeout(t); }
    };
    try { return await get(url); } catch (e) {}
    for (const wrap of V.CORS_PROXIES) {
      try { return await get(wrap(url)); } catch (e) {}
    }
    throw new Error("no image");
  }

  /**
   * Downloads a track's audio, trying other servers and relays when one fails.
   * @param {string} id Video id.
   * @param {number} maxBytes Larger files are refused.
   * @param {(received: number, total: number) => void} [onProgress] `total` is 0 when unknown.
   * @param {ResolveOptions} [options]
   * @returns {Promise<Blob>} Rejects with `oversize: true` on the error when the file is too large.
   */
  async function fetchStreamBlob(id, maxBytes, onProgress, options) {
    // Too long for the cache is a fact about the track, not about the route it came by.
    const oversize = bytes => Object.assign(new Error("too large (" + Math.round(bytes / 1048576) + "MB)"), { oversize: true });
    const tryFetch = async (u, mime) => {
      const ctl = new AbortController();
      let lastByteAt = Date.now();
      let stalled = false;
      let giveUp;
      // Aborting asks the transfer to stop; it does not guarantee the pending read ever
      // settles. This promise is raced against every read so a source that goes quiet
      // can never hold the download open indefinitely.
      const stallPromise = new Promise((_, rej) => { giveUp = rej; });
      stallPromise.catch(() => {});
      const watch = setInterval(() => {
        if (Date.now() - lastByteAt <= STALL_MS) return;
        stalled = true;
        ctl.abort();
        giveUp(new Error("stalled, nothing arrived for " + Math.round(STALL_MS / 1000) + "s"));
      }, 1000);
      try {
        const res = await Promise.race([fetch(u, { signal: ctl.signal }), stallPromise]);
        lastByteAt = Date.now();
        if (!res.ok) throw new Error("HTTP " + res.status);
        if (/^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(res.headers.get("content-type") || "")) {
          ctl.abort();
          throw new Error("source returned a page instead of audio");
        }
        // Ask the size before pulling the body. An oversize track used to be downloaded
        // in full and only then measured against the cache limit and discarded - on a
        // phone that is real data spent to produce nothing.
        const declared = parseInt(res.headers.get("content-length") || "", 10);
        if (maxBytes && declared > maxBytes) {
          ctl.abort();
          throw oversize(declared);
        }
        let blob;
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          const chunks = [];
          let got = 0;
          for (;;) {
            const step = await Promise.race([reader.read(), stallPromise]);
            if (step.done) break;
            lastByteAt = Date.now();
            got += step.value.byteLength;
            // Now enforced as it arrives, not only from a header a proxy may not send.
            if (maxBytes && got > maxBytes) {
              ctl.abort();
              throw oversize(got);
            }
            chunks.push(step.value);
            if (onProgress) { try { onProgress(got, declared > 0 ? declared : 0); } catch (e) {} }
          }
          blob = new Blob(chunks, { type: mime || res.headers.get("content-type") || "" });
        } else {
          blob = await Promise.race([res.blob(), stallPromise]);
        }
        if (maxBytes && blob.size > maxBytes) throw oversize(blob.size);
        if (blob.size < 100 * 1024) throw new Error("too small");
        // A connection that dies mid-download hands back a perfectly valid short blob.
        // Stored, that is a track that plays for forty seconds and stops - offline, for
        // good. If the server said how long it is, it has to be that long.
        if (declared > 0 && blob.size < declared * 0.98) {
          throw new Error("truncated (" + Math.round(blob.size / 1024) + "KB of " + Math.round(declared / 1024) + "KB)");
        }
        if (mime && blob.type !== mime) blob = new Blob([blob], { type: mime });
        return blob;
      } catch (e) {
        if (!stalled) throw e;
        throw new Error("stalled, nothing arrived for " + Math.round(STALL_MS / 1000) + "s");
      } finally {
        clearInterval(watch);
      }
    };
    const triedBases = new Set();
    for (let attempt = 0; attempt < 6; attempt++) {
      let info;
      // The same race would be won by the same server: the ones whose stream could not
      // be fetched are left out, so the next attempt really is another source.
      try { info = await V.resolve(id, Object.assign({}, options, { avoid: triedBases })); }
      catch (e) { V.log("blob", id + " no source left: " + String(e.message || e).slice(0, 50)); break; }

      const srcKey = info.base || info.url;
      if (triedBases.has(srcKey)) {
        V.log("blob", id + " only the same source " + V.host(srcKey) + " left, giving up");
        V.invalidate(id, false);
        break;
      }
      triedBases.add(srcKey);

      try {
        const b = await tryFetch(info.url, info.mime);
        V.log("blob", id + " direct OK " + Math.round(b.size / 1024) + "KB via " + V.host(info.url));
        return b;
      } catch (e) {
        V.log("blob", id + " direct fail (" + V.host(info.url) + "): " + String(e.message || e).slice(0, 50));
        // The track is too long wherever it comes from; a proxy that sends no length
        // would stream up to the limit again before finding that out.
        if (e && e.oversize) throw e;
      }

      let got = null;
      // A private stream ticket must stay between this app, its server and the receiver.
      const privateTicket = !!info.expiresAt && new URL(info.url).pathname === "/media/play";
      for (const wrap of privateTicket ? [] : V.CORS_PROXIES) {
        try {
          got = await tryFetch(wrap(info.url), info.mime);
          V.log("blob", id + " proxy OK " + Math.round(got.size / 1024) + "KB");
          break;
        } catch (e) {
          V.log("blob", id + " proxy fail: " + String(e.message || e).slice(0, 50));
          if (e && e.oversize) throw e;
        }
      }
      if (got) return got;

      V.invalidate(id, false);
      V.log("blob", id + " blob fetch failed via " + V.host(info.url) + ", trying another");
    }
    V.log("blob", id + " ALL sources exhausted");
    throw new Error("stream fetch blocked");
  }
})();
