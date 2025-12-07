const axios = require("axios");

/**
 * Клас для роботи з Viber Public Account API
 * Інкапсулює всю логіку взаємодії з Viber API
 */
class ViberClient {
	constructor(authToken) {
		this.authToken = authToken;
		this.baseUrl = "https://chatapi.viber.com/pa";
		this.maxTextLength = 1000;
		this.maxCaptionLength = 767;
	}

	/**
	 * Отримує заголовки для запитів
	 */
	getHeaders() {
		return {
			"Content-Type": "application/json",
			"X-Viber-Auth-Token": this.authToken,
		};
	}

	/**
	 * Встановлює webhook для каналу
	 * @param {string} webhookUrl - URL для webhook
	 * @returns {Promise<Object>}
	 */
	async setWebhook(webhookUrl) {
		try {
			const response = await axios.post(
				`${this.baseUrl}/set_webhook`,
				{
					url: webhookUrl,
					auth_token: this.authToken,
				},
				{
					headers: this.getHeaders(),
				}
			);
			if (response.data.status === 0) {
				console.log("Webhook встановлено для каналу з токеном:", this.authToken);
				return { success: true, data: response.data };
			} else {
				// Webhook не обов'язковий для відправки повідомлень у канал
				console.warn(
					"Не вдалося встановити webhook (не критично для відправки повідомлень):",
					response.data.status_message || response.data
				);
				return { success: false, error: response.data, warning: true };
			}
		} catch (error) {
			// Webhook не обов'язковий для відправки повідомлень у канал
			console.warn(
				"Помилка встановлення webhook (не критично для відправки повідомлень):",
				error.response?.data?.status_message || error.message
			);
			return {
				success: false,
				error: error.response?.data || error.message,
				warning: true,
			};
		}
	}

	/**
	 * Отримує інформацію про канал
	 * @returns {Promise<Object>}
	 */
	async getAccountInfo() {
		try {
			const response = await axios.post(
				`${this.baseUrl}/get_account_info`,
				{ auth_token: this.authToken },
				{
					headers: this.getHeaders(),
				}
			);
			console.log("Отримано get_account_info:", response.data);
			return { success: response.data.status === 0, data: response.data };
		} catch (error) {
			console.error(
				"Помилка отримання get_account_info:",
				error.response?.data || error.message
			);
			return {
				success: false,
				error: error.response?.data || error.message,
			};
		}
	}

	/**
	 * Отримує ID адміністратора каналу
	 * @returns {Promise<string|null>}
	 */
	async getChannelAdminId() {
		try {
			const result = await this.getAccountInfo();
			if (
				result.success &&
				result.data.members &&
				result.data.members.length > 0
			) {
				const admin =
					result.data.members.find(
						(member) => member.role === "superadmin"
					) ||
					result.data.members.find((member) => member.role === "admin");
				return admin ? admin.id : null;
			} else {
				console.error(
					"Не вдалося отримати інформацію про канал",
					result.data
				);
				return null;
			}
		} catch (error) {
			console.error(
				"Помилка отримання admin ID:",
				error.response?.data || error.message
			);
			return null;
		}
	}

	/**
	 * Відправляє повідомлення через Viber API
	 * @param {Object} payload - Дані для відправки
	 * @returns {Promise<Object>}
	 */
	async sendMessage(payload) {
		try {
			const response = await axios.post(
				`${this.baseUrl}/post`,
				{
					auth_token: this.authToken,
					...payload,
				},
				{
					headers: this.getHeaders(),
				}
			);
			// Перевіряємо, що повідомлення дійсно прийнято (status === 0)
			const isSuccess = response.data && response.data.status === 0;
			return { 
				success: isSuccess, 
				data: response.data,
				messageToken: response.data?.message_token 
			};
		} catch (error) {
			console.error(
				"Помилка надсилання повідомлення:",
				error.response?.data || error.message
			);
			return {
				success: false,
				error: error.response?.data || error.message,
			};
		}
	}


	/**
	 * Відправляє текстове повідомлення (весь текст без розділення)
	 * @param {string} text - Текст для відправки
	 * @param {string} adminId - ID адміністратора каналу
	 * @returns {Promise<void>}
	 */
	async sendText(text, adminId) {
		console.log(`[sendText] Відправляємо весь текст довжиною: ${text.length} символів`);
		
		const result = await this.sendMessage({
			from: adminId,
			type: "text",
			text: text,
		});
		
		if (result.success && result.data && result.data.status === 0) {
			console.log("Текст відправлено. Відповідь:", result.data);
		} else {
			console.error("Помилка відправки тексту:", result.error || result.data);
		}
	}

	/**
	 * Відправляє фото у Viber канал
	 * @param {string} mediaUrl - URL фото
	 * @param {string} caption - Підпис до фото
	 * @param {string} adminId - ID адміністратора каналу
	 * @returns {Promise<void>}
	 */
	async sendPicture(mediaUrl, caption, adminId) {
		// Якщо caption існує і його розмір перевищує ліміт, надсилаємо фото без підпису
		if (caption && caption.length > this.maxCaptionLength) {
			const result = await this.sendMessage({
				from: adminId,
				type: "picture",
				text: "", // надсилаємо фото без підпису
				media: mediaUrl.toString(),
			});

			if (result.success) {
				console.log("Фото відправлено без підпису. Відповідь:", result.data);
				// Надсилаємо caption окремо, розбитий на частини
				await this.sendText(caption, adminId);
			} else {
				console.error("Помилка надсилання фото:", result.error);
			}
		} else {
			// Якщо caption у межах допустимого ліміту, відправляємо фото разом із підписом
			const result = await this.sendMessage({
				from: adminId,
				type: "picture",
				text: caption || "",
				media: mediaUrl.toString(),
			});

			if (result.success) {
				console.log("Фото відправлено. Відповідь:", result.data);
			} else {
				console.error("Помилка надсилання фото:", result.error);
			}
		}
	}

	/**
	 * Відправляє відео у Viber канал
	 * @param {string} mediaUrl - URL відео
	 * @param {string} caption - Підпис до відео
	 * @param {number} fileSize - Розмір файлу в байтах
	 * @param {number} duration - Тривалість відео в секундах
	 * @param {string} adminId - ID адміністратора каналу
	 * @returns {Promise<void>}
	 */
	async sendVideo(mediaUrl, caption, fileSize, duration, adminId) {
		// Якщо caption існує і його розмір перевищує ліміт, надсилаємо відео без підпису
		if (caption && caption.length > this.maxCaptionLength) {
			const result = await this.sendMessage({
				from: adminId,
				type: "video",
				text: "", // надсилаємо відео без підпису
				media: mediaUrl.toString(),
				size: fileSize,
				duration: duration,
			});

			if (result.success) {
				console.log("Відео відправлено без підпису. Відповідь:", result.data);
				// Надсилаємо caption окремо, розбитий на частини
				await this.sendText(caption, adminId);
			} else {
				console.error("Помилка надсилання відео:", result.error);
			}
		} else {
			// Якщо caption у межах допустимого ліміту або відсутній, надсилаємо відео з підписом
			const result = await this.sendMessage({
				from: adminId,
				type: "video",
				text: caption || "",
				media: mediaUrl.toString(),
				size: fileSize,
				duration: duration,
			});

			if (result.success) {
				console.log("Відео відправлено. Відповідь:", result.data);
			} else {
				console.error("Помилка надсилання відео:", result.error);
			}
		}
	}
}

module.exports = ViberClient;

