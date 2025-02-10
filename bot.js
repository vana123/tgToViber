require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const Database = require("better-sqlite3");

const db = new Database("bot.db");

// Створення таблиці
db.prepare(
	`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    viber_token TEXT,
    telegram_chat_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`
).run();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Допоміжна функція для логування користувачу
function logUser(ctx, message) {
	// Виводимо у консоль і відправляємо повідомлення користувачу
	console.log(message);
	// Якщо ctx доступний, надсилаємо відповідь
	if (ctx && ctx.reply) {
		ctx.reply(message);
	}
}

// Обробник додання бота в канал
bot.on("my_chat_member", async (ctx) => {
	if (ctx.myChatMember.new_chat_member.status === "administrator") {
		try {
			const chatInfo = await ctx.getChat();
			const message = `📢 Ви додали бота в канал:
Назва: ${chatInfo.title}
Тип: ${chatInfo.type}
Chat ID: ${chatInfo.id}

Щоб налаштувати дублювання, використовуйте команду:
/setup [viber_token] ${chatInfo.id}`;

			try {
				await ctx.telegram.sendMessage(ctx.from.id, message);
				logUser(ctx, "Інформація про канал надіслана у приватний чат.");
			} catch (error) {
				if (
					error.response &&
					error.response.description &&
					error.response.description.includes("bot was kicked")
				) {
					console.warn("Бот був вилучений, але дані про канал відправляємо.");
					await ctx.reply(message);
				} else {
					throw error;
				}
			}
		} catch (error) {
			console.error("Помилка відправки інформації про канал:", error);
			logUser(
				ctx,
				"🚨 Помилка відправки інформації про канал: " + error.message
			);
		}
	}
});

// Команда start – інструкція для користувача
bot.command("start", (ctx) => {
	const instruction = `Привіт! Я – бот для дублювання повідомлень із Telegram каналів до Viber каналів.
  
Основні команди:
• /setup <viber_token> <telegram_chat_id> – додати канал для пересилання (вкажіть Viber токен і ID Telegram‑каналу).
   (Дізнатись <viber_token>: відкрийте налаштування каналу в Viber, перейдіть до "Developer Tools" і скопіюйте токен;
    <telegram_chat_id>: додайте мене в канал.)
• /list – переглянути список ваших налаштованих каналів.
• /pause <channel_id> – призупинити пересилання повідомлень.
• /continue <channel_id> – відновити пересилання.
• /delete <channel_id> – видалити канал з налаштувань.
• /ping – протестувати інтеграцію.`;
	ctx.reply(instruction);
});

// Команда налаштування
bot.command("setup", async (ctx) => {
	const args = ctx.message.text.split(" ").slice(1);
	if (args.length !== 2) {
		return ctx.reply(
			"❌ Невірний формат! Використовуйте: /setup <viber_token> <telegram_chat_id>"
		);
	}
	const [viberToken, telegramChatId] = args;
	try {
		logUser(ctx, "Перевірка Viber токена та встановлення webhook...");
		await setViberWebhookForChannel(viberToken);
		// Використовуємо POST запит; видаляємо властивість params з тіла
		const viberCheck = await axios.post(
			"https://chatapi.viber.com/pa/get_account_info",
			{ auth_token: viberToken },
			{
				headers: {
					"Content-Type": "application/json",
					"X-Viber-Auth-Token": viberToken,
				},
			}
		);
		console.log("Отримано get_account_info:", viberCheck.data);
		if (viberCheck.data.status !== 0) {
			logUser(ctx, "❌ Невірний Viber токен!");
			return;
		}
		logUser(ctx, "Viber токен перевірено успішно.");
		// Перевірка доступу до Telegram каналу
		const chatMember = await ctx.telegram.getChatMember(
			telegramChatId,
			ctx.botInfo.id
		);
		if (chatMember.status !== "administrator") {
			return ctx.reply("❌ Бот не є адміністратором цього каналу!");
		}
		// Перевірка, чи канал вже доданий
		const exists = db
			.prepare(
				`SELECT 1 FROM channels WHERE telegram_chat_id = ? AND user_id = ?`
			)
			.get(telegramChatId, ctx.from.id);
		if (exists) {
			return ctx.reply("ℹ️ Цей канал вже доданий!");
		}
		// Збереження в базу даних
		db.prepare(
			`
      INSERT INTO channels (user_id, viber_token, telegram_chat_id)
      VALUES (?, ?, ?)
    `
		).run(ctx.from.id, viberToken, telegramChatId);
		sendToAdmin(`Підключено новий канал: ${telegramChatId}`);
		logUser(ctx, `✅ Налаштування успішно збережено! Канал: ${telegramChatId}`);
	} catch (error) {
		console.error("Помилка налаштування:", error);
		logUser(ctx, "🚨 Помилка налаштування: " + error.message);
	}
});

// Команда списку каналів
bot.command("list", (ctx) => {
	const channels = db
		.prepare(
			`
      SELECT id, telegram_chat_id, viber_token, is_active 
      FROM channels 
      WHERE user_id = ?
    `
		)
		.all(ctx.from.id);
	if (!channels.length) {
		return ctx.reply("ℹ️ У вас немає налаштованих каналів");
	}
	const list = channels
		.map(
			(ch) => `
ID: ${ch.id}
Telegram Chat ID: ${ch.telegram_chat_id}
Viber Token: ${ch.viber_token.slice(0, 6)}...
Статус: ${ch.is_active ? "активний ✅" : "призупинено ⏸"}`
		)
		.join("\n\n");
	logUser(ctx, "📋 Ваші канали:" + list);
});

// Команда паузи
bot.command("pause", (ctx) => {
	const args = ctx.message.text.split(" ").slice(1);
	if (!args[0]) return ctx.reply("❌ Вкажіть ID каналу: /pause <channel_id>");
	db.prepare(
		`
      UPDATE channels 
      SET is_active = 0 
      WHERE id = ? AND user_id = ?
    `
	).run(args[0], ctx.from.id);
	logUser(ctx, `⏸ Копіювання для каналу ID ${args[0]} призупинено.`);
});

// Команда "continue" – відновлення каналу
bot.command("continue", (ctx) => {
	const args = ctx.message.text.split(" ").slice(1);
	if (!args[0])
		return ctx.reply("❌ Вкажіть ID каналу: /continue <channel_id>");
	db.prepare(
		`
      UPDATE channels 
      SET is_active = 1 
      WHERE id = ? AND user_id = ?
    `
	).run(args[0], ctx.from.id);
	logUser(ctx, `▶️ Копіювання для каналу ID ${args[0]} відновлено.`);
});

// Команда видалення
bot.command("delete", (ctx) => {
	const args = ctx.message.text.split(" ").slice(1);
	if (!args[0]) return ctx.reply("❌ Вкажіть ID каналу: /delete <channel_id>");
	try {
		const info = db
			.prepare(
				`
        DELETE FROM channels 
        WHERE id = ? AND user_id = ?
      `
			)
			.run(args[0], ctx.from.id);
		if (info.changes === 0) {
			return ctx.reply("❌ Канал не знайдено або не належить вам!");
		}
		logUser(ctx, `🗑 Канал ID ${args[0]} видалено.`);
	} catch (error) {
		console.error("Помилка видалення:", error);
		logUser(ctx, "🚨 Помилка видалення: " + error.message);
	}
});

function sendToAdmin(message) {
	bot.telegram.sendMessage(process.env.BOT_ADMIN_CHAT_ID, `${message}`);
}

// Обробка постів (пересилання повідомлень з Telegram каналу до Viber каналу)
bot.on("channel_post", async (ctx) => {
	try {
		// Отримуємо конфігурації каналу разом із user_id
		const channels = db
			.prepare(
				`
			SELECT user_id, viber_token 
			FROM channels 
			WHERE telegram_chat_id = ? 
			  AND is_active = 1
		  `
			)
			.all(ctx.chat.id.toString());
		if (!channels.length) return;

		// Для кожного налаштованого запису (кожного користувача)
		for (const channel of channels) {
			// Допоміжна функція для надсилання логів у особисті повідомлення користувача
			const logToUser = (message) => {
				bot.telegram.sendMessage(channel.user_id, message);
			};

			try {
				logToUser(
					`Лог: отримано пост у Telegram каналі ${ctx.chat.username} (ID: ${ctx.chat.id},). `
				);
				// Обробка текстового повідомлення
				if (ctx.channelPost.text) {
					logToUser("Лог: обробка текстового повідомлення...: \n");
					await setViberWebhookForChannel(channel.viber_token);
					const adminId = await getChannelAdminId(channel.viber_token);
					const textWithLinks = addLinks(
						ctx.channelPost.text,
						ctx.channelPost.entities
					);
					await viberSendText(textWithLinks, channel.viber_token, adminId);
					logToUser("Лог: текстове повідомлення переслано.");
				}
				// Обробка фото
				if (ctx.channelPost.photo) {
					logToUser("Лог: обробка фото...");
					const photoArray = ctx.channelPost.photo;
					const caption = ctx.channelPost.caption
						? addLinks(
								ctx.channelPost.caption,
								ctx.channelPost.caption_entities
						  )
						: "";
					// Беремо найкращу якість (останній елемент)
					const bestPhoto = photoArray[photoArray.length - 1];
					const link = await bot.telegram.getFileLink(bestPhoto.file_id);
					await viberSendPicture(
						link,
						caption,
						channel.viber_token,
						await getChannelAdminId(channel.viber_token)
					);
					logToUser("Лог: фото переслано.");
				}
				// Обробка відео
				if (ctx.channelPost.video) {
					logToUser("Лог: обробка відео...");
					const video = ctx.channelPost.video;
					const link = await bot.telegram.getFileLink(video.file_id);
					const caption = ctx.channelPost.caption
						? addLinks(
								ctx.channelPost.caption,
								ctx.channelPost.caption_entities
						  )
						: "";
					await viberSendVideo(
						link,
						caption,
						video.file_size,
						video.duration,
						channel.viber_token,
						await getChannelAdminId(channel.viber_token)
					);
					logToUser("Лог: відео переслано.");
				}
			} catch (error) {
				console.error(
					"Помилка відправки:",
					error.response?.data || error.message
				);
				logToUser(
					"Лог: помилка відправки: " + (error.response?.data || error.message)
				);
				sendToAdmin(
					`Помилка відправки: ${error.response?.data || error.message}`
				);
			}
		}
	} catch (error) {
		console.error("Помилка обробки поста:", error);
		sendToAdmin("Лог: Помилка обробки поста: " + error.message);
	}
});

// Функція для відправки текстового повідомлення у Viber канал
function viberSendText(text, viberToken, adminId) {
	const SendMessageUrl = "https://chatapi.viber.com/pa/post";
	const payload = {
		auth_token: viberToken,
		from: adminId,
		type: "text",
		text: text,
	};
	axios
		.post(SendMessageUrl, payload)
		.then((response) => {
			console.log("Повідомлення відправлено. Відповідь:", response.data);
		})
		.catch((error) => {
			console.error(
				"Помилка надсилання тексту:",
				error.response?.data || error.message
			);
		});
}

// Функція для відправки фото у Viber канал
function viberSendPicture(link, caption, viberToken, adminId) {
	const SendMessageUrl = "https://chatapi.viber.com/pa/post";

  // Якщо підпис перевищує 768 символів, відправляємо фото без підпису
  if (caption && caption.length > 768) {
    const payloadPicture = {
      auth_token: viberToken,
      from: adminId,
      type: "picture",
      text: "", // без підпису
      media: link.toString(),
    };

    axios.post(SendMessageUrl, payloadPicture, {
      headers: {
        "Content-Type": "application/json",
        "X-Viber-Auth-Token": viberToken,
      },
    })
    .then((response) => {
      console.log("Фото відправлено без підпису. Відповідь:", response.data);
      // Надсилаємо окремо підпис як текстове повідомлення
      viberSendText(caption, viberToken, adminId);
    })
    .catch((error) => {
      console.error("Помилка надсилання фото:", error.response?.data || error.message);
      sendToAdmin("Помилка надсилання фото: " + (error.response?.data || error.message));
    });
  } else {
    // Якщо підпис допустимий, відправляємо фото з підписом
    const payloadPicture = {
      auth_token: viberToken,
      from: adminId,
      type: "picture",
      text: caption,
      media: link.toString(),
    };

    axios.post(SendMessageUrl, payloadPicture, {
      headers: {
        "Content-Type": "application/json",
        "X-Viber-Auth-Token": viberToken,
      },
    })
    .then((response) => {
      console.log("Фото відправлено. Відповідь:", response.data);
    })
    .catch((error) => {
      console.error("Помилка надсилання фото:", error.response?.data || error.message);
      sendToAdmin("Помилка надсилання фото: " + (error.response?.data || error.message));
    });
  }
}

// Функція для відправки відео у Viber канал
function viberSendVideo(
	link,
	caption,
	fileSize,
	duration,
	viberToken,
	adminId
) {
	const SendMessageUrl = "https://chatapi.viber.com/pa/post";
	const payload = {
		auth_token: viberToken,
		from: adminId,
		type: "video",
		text: caption,
		media: link.toString(),
		size: fileSize,
		duration: duration,
	};
	axios
		.post(SendMessageUrl, payload)
		.then((response) => {
			console.log("Відео відправлено. Відповідь:", response.data);
		})
		.catch((error) => {
			console.error(
				"Помилка надсилання відео:",
				error.response?.data || error.message
			);
		});
}

// Функція для додавання посилань у текст
function addLinks(text, entities) {
	if (!entities || entities.length === 0) return text;
	entities.sort((a, b) => a.offset - b.offset);
	let result = "";
	let currentIndex = 0;
	for (const entity of entities) {
		result += text.substring(currentIndex, entity.offset);
		const entityText = text.substring(
			entity.offset,
			entity.offset + entity.length
		);
		if (entity.type === "text_link" && entity.url) {
			result += `${entityText} (${entity.url})`;
		} else if (entity.type === "url") {
			result += `<a href="${entityText}">${entityText}</a>`;
		} else {
			result += entityText;
		}
		currentIndex = entity.offset + entity.length;
	}
	result += text.substring(currentIndex);
	return result;
}

async function getChannelAdminId(authToken) {
	try {
		const response = await axios.post(
			"https://chatapi.viber.com/pa/get_account_info",
			{ auth_token: authToken },
			{
				headers: {
					"Content-Type": "application/json",
					"X-Viber-Auth-Token": authToken,
				},
			}
		);
		console.log("Отримано get_account_info:", response.data);
		if (
			response.data.status === 0 &&
			response.data.members &&
			response.data.members.length > 0
		) {
			const admin =
				response.data.members.find((member) => member.role === "superadmin") ||
				response.data.members.find((member) => member.role === "admin");
			return admin ? admin.id : null;
		} else {
			console.error("Не вдалося отримати інформацію про канал", response.data);
			return null;
		}
	} catch (error) {
		console.error(
			"Помилка отримання get_account_info:",
			error.response?.data || error.message
		);
		return null;
	}
}

// Функція для встановлення webhook для конкретного каналу
async function setViberWebhookForChannel(viberToken) {
	const SetWebHookUrl = "https://chatapi.viber.com/pa/set_webhook";
	const SetWebData = {
		url: "https://webhook.site/b94ba94f-b294-4c7d-9cdd-5bd589f19bc7",
		auth_token: viberToken,
	};
	try {
		const response = await axios.post(SetWebHookUrl, SetWebData, {
			headers: {
				"Content-Type": "application/json",
				"X-Viber-Auth-Token": viberToken,
			},
		});
		if (response.data.status === 0) {
			console.log("Webhook встановлено для каналу з токеном:", viberToken);
		} else {
			console.error("Помилка встановлення webhook:", response.data);
		}
	} catch (error) {
		console.error(
			"Помилка встановлення webhook:",
			error.response?.data || error.message
		);
	}
}

bot.command("ping", async (ctx) => {
	logUser(ctx, "Виконується команда /ping...");
	await setViberWebhookForChannel(process.env.VIBER_AUTH_TOKEN);
	const adminId = await getChannelAdminId(process.env.VIBER_AUTH_TOKEN);
	await viberSendText("ping", process.env.VIBER_AUTH_TOKEN, adminId);
	logUser(ctx, "Команда /ping виконана, повідомлення 'ping' відправлено.");
	ctx.reply("ping");
});

// Обробка глобальних помилок
bot.catch((err, ctx) => {
	console.error("Глобальна помилка:", err);
	if (ctx && ctx.reply) {
		ctx.reply("🚨 Сталася помилка. Будь ласка, спробуйте пізніше.");
	}
	sendToAdmin(`Глобальна помилка: ${err}`);
});

bot.launch();
console.log("🤖 Бот запущений!");
