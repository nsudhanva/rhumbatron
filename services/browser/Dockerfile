# Browser: a Playwright server that browser checks connect to over WebSocket.
# The client in core pins playwright-core to the same version.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN npm install --global playwright@1.64.1 && npm cache clean --force
USER pwuser
WORKDIR /home/pwuser
EXPOSE 3000
CMD ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]
