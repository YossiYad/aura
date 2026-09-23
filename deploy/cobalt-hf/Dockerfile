FROM ghcr.io/imputnet/cobalt:10

ENV API_PORT=7860
ENV API_LISTEN_ADDRESS=0.0.0.0
ENV COOKIE_PATH=/tmp/cookies.json

# Cookies come from the HF Space secret COOKIES_JSON (not committed to the repo),
# written to a runtime file just before cobalt starts. Keeps the YouTube session
# out of the public Space files while still letting the public API reach it.
CMD ["sh", "-c", "printf '%s' \"$COOKIES_JSON\" > /tmp/cookies.json && exec node src/cobalt"]
