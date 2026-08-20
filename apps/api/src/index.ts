import { createApp } from "./app.js";
import { configureEvents } from "./lib/events.js";

configureEvents();

const app = createApp();
const port = Number(process.env.PORT ?? 8080);

app.listen(port, () => {
  console.log(`AgentEngineEasy API listening on :${port}`);
});
