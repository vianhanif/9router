import { Hono } from "hono";

import { chatCompletionsRouter } from "./chat/completions.js";
import { embeddingsRouter } from "./embeddings.js";
import { imageGenerationsRouter } from "./images/generations.js";
import { ttsRouter } from "./audio/speech.js";
import { sttRouter } from "./audio/transcriptions.js";
import { voicesRouter } from "./audio/voices.js";
import { searchRouter } from "./search.js";
import { fetchRouter } from "./web/fetch.js";
import { messagesRouter } from "./messages.js";
import { countTokensRouter } from "./messages/count_tokens.js";
import { apiChatRouter } from "./api/chat.js";
import { responsesRouter } from "./responses.js";
import { responsesCompactRouter } from "./responses/compact.js";
import { modelsRouter } from "./models.js";
import { modelsKindRouter } from "./models/kind.js";
import { modelsInfoRouter } from "./models/info.js";

const v1 = new Hono();

// Mount all route modules
v1.route("/", chatCompletionsRouter);
v1.route("/", embeddingsRouter);
v1.route("/", imageGenerationsRouter);
v1.route("/", ttsRouter);
v1.route("/", sttRouter);
v1.route("/", voicesRouter);
v1.route("/", searchRouter);
v1.route("/", fetchRouter);
v1.route("/", messagesRouter);
v1.route("/", countTokensRouter);
v1.route("/", apiChatRouter);
v1.route("/", responsesRouter);
v1.route("/", responsesCompactRouter);
v1.route("/", modelsRouter);
v1.route("/", modelsKindRouter);
v1.route("/", modelsInfoRouter);

export { v1 as v1Router };
