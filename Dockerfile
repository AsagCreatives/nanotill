# Only needed if you run this on your own server instead of Netlify.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
