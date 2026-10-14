import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import DashboardSidebar from "@/components/DashboardSidebar";
import { useDashboardSidebarItems } from "@/hooks/useDashboardSidebarItems";
import { apiBase, apiPost, apiUploadForm } from "@/lib/api";
import {
  buildTalkMeCustomFields,
  buildTalkMeVisitorName,
  ensureTalkMeScript,
  setTalkMeClientInfo,
} from "@/lib/talkme";
import { getVpnTalkmeProfileRaw } from "@/lib/vpnStorage";
import LandingFooter from "@/pages/landing/LandingFooter";
import LandingShell from "@/pages/landing/LandingShell";

type ChatAttachmentKind = "image" | "video" | "zip" | "file";

type ChatAttachment = {
  url: string;
  fileName: string;
  mimeType?: string;
  kind?: ChatAttachmentKind;
};

type ChatMessage = {
  id: number;
  text: string;
  sender: "client" | "operator";
  operatorName: string | null;
  dateTime: string;
  status: string;
  attachments?: ChatAttachment[];
};

type ClientIdResponse = {
  clientId?: string;
};

type MessagesResponse = {
  messages?: ChatMessage[];
  hasVisitor?: boolean;
};

type SendResponse = {
  messageId?: number | null;
  clientId?: string;
};

type ChatAttachmentUploadResponse = {
  url?: string;
  path?: string;
  fileName?: string;
  mimeType?: string;
  kind?: ChatAttachmentKind;
};

type DialogStatusResponse = {
  statusLabel?: string | null;
};

type OperatorListResponse = {
  onlineCount?: number;
};

type OperatorTypingResponse = {
  typing?: boolean;
};

async function talkmePost<T>(
  path: string,
  body: Record<string, unknown>,
  onAuthError?: () => void,
): Promise<T> {
  const { data, error, status } = await apiPost<T>(path, body);
  if (error) {
    if (status === 401 && onAuthError) {
      onAuthError();
    }
    throw error;
  }
  return (data ?? {}) as T;
}

async function uploadChatAttachment(
  file: File,
  onAuthError?: () => void,
): Promise<ChatAttachmentUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const { data, error, status } = await apiUploadForm<ChatAttachmentUploadResponse>(
    "/support/chat-attachment",
    formData,
  );

  if (error) {
    if (status === 401 && onAuthError) {
      onAuthError();
    }
    throw error;
  }

  return (data ?? {}) as ChatAttachmentUploadResponse;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function messageMatchesSentMessage(
  message: ChatMessage,
  optimisticMessage: ChatMessage,
  sentMessageId?: number | null,
): boolean {
  if (sentMessageId && message.id === sentMessageId) return true;
  if (message.sender !== "client") return false;

  const sentAt = Date.parse(optimisticMessage.dateTime);
  const messageAt = Date.parse(message.dateTime);
  if (Number.isFinite(sentAt) && Number.isFinite(messageAt) && messageAt < sentAt - 10_000) {
    return false;
  }

  const sentText = optimisticMessage.text.trim();
  return sentText ? message.text.includes(sentText) : Boolean(optimisticMessage.attachments?.length);
}

/** Сообщения — каждые 8 с; мета (операторы, статус, typing) — каждые 20 с. */
const CHAT_MESSAGES_POLL_MS = 8_000;
const CHAT_META_POLL_MS = 20_000;
/** Догоняем свежеотправленное сообщение чаще, чем обычный поллинг. */
const CHAT_SEND_SYNC_DELAYS_MS = [700, 1500, 2500, 4000];

function formatMessageTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const videoExtensions = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv", "ogg"]);

function getFileExtension(value: string): string {
  const cleanValue = value.split(/[?#]/)[0] || "";
  const match = cleanValue.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() || "";
}

function getFileNameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const name = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    return name || "Вложение";
  } catch {
    return "Вложение";
  }
}

function getAttachmentKind(
  attachment: Pick<ChatAttachment, "fileName" | "kind" | "mimeType" | "url">,
): ChatAttachmentKind {
  if (attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "zip") {
    return attachment.kind;
  }

  const mimeType = attachment.mimeType?.toLowerCase() || "";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.includes("zip")) return "zip";

  const extension = getFileExtension(attachment.fileName) || getFileExtension(attachment.url);
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (extension === "zip") return "zip";

  return "file";
}

function isSupportAttachmentUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes("/support/chat-attachment/");
  } catch {
    return false;
  }
}

function singleUrlFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

function MessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/gi);

  return (
    <p>
      {parts.map((part, index) =>
        /^https?:\/\//i.test(part) ? (
          <a href={part} key={`${part}-${index}`} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/**
 * Операторы (TalkMe) присылают вложения одной строкой вида
 * `имя-файла.jpg (8 Kb) https://fs.site-chat.me/.../file.jpg`.
 * Вытаскиваем из такой строки ссылку и человекочитаемое имя.
 */
function inlineAttachmentFromLine(line: string): ChatAttachment | null {
  const trimmed = line.trim();
  const urlMatch = trimmed.match(/\s+(https?:\/\/\S+)$/i);
  if (!urlMatch) return null;

  const url = urlMatch[1];
  const textBeforeUrl = trimmed.slice(0, urlMatch.index).trim();
  const sizeMatch = textBeforeUrl.match(
    /^(.+?)\s*\(\s*\d+(?:[.,]\d+)?\s*(?:b|kb|kib|mb|mib|gb|gib|байт(?:а|ов)?|кб|мб|гб)\s*\)$/i,
  );
  if (!sizeMatch) return null;

  const fileName = sizeMatch[1].trim() || getFileNameFromUrl(url);
  const kind = getAttachmentKind({ url, fileName });

  if (kind === "file" && !isSupportAttachmentUrl(url)) return null;

  return { url, fileName, kind };
}

export function parseMessageForDisplay(message: ChatMessage): { text: string; attachments: ChatAttachment[] } {
  const attachments = [...(message.attachments ?? [])];
  const textLines: string[] = [];
  const lines = message.text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fileNameMatch = line.trim().match(/^Файл:\s*(.+)$/i);
    const nextUrl = index + 1 < lines.length ? singleUrlFromLine(lines[index + 1]) : null;

    if (fileNameMatch && nextUrl) {
      const fileName = fileNameMatch[1].trim() || getFileNameFromUrl(nextUrl);
      attachments.push({
        url: nextUrl,
        fileName,
        kind: getAttachmentKind({ url: nextUrl, fileName }),
      });
      index += 1;
      continue;
    }

    const inlineAttachment = inlineAttachmentFromLine(line);
    if (inlineAttachment) {
      attachments.push(inlineAttachment);
      continue;
    }

    const lineUrl = singleUrlFromLine(line);
    if (lineUrl) {
      const fileName = getFileNameFromUrl(lineUrl);
      const kind = getAttachmentKind({ url: lineUrl, fileName });
      if (kind !== "file" || isSupportAttachmentUrl(lineUrl)) {
        attachments.push({ url: lineUrl, fileName, kind });
        continue;
      }
    }

    textLines.push(line);
  }

  const uniqueAttachments = attachments.filter(
    (attachment, index, all) => all.findIndex((candidate) => candidate.url === attachment.url) === index,
  );

  return {
    text: textLines.join("\n").trim(),
    attachments: uniqueAttachments,
  };
}

function ChatAttachmentPreview({
  attachment,
  onImageClick,
}: {
  attachment: ChatAttachment;
  onImageClick: (attachment: ChatAttachment) => void;
}) {
  const kind = getAttachmentKind(attachment);
  const fileName = attachment.fileName || getFileNameFromUrl(attachment.url);

  if (kind === "image") {
    return (
      <div className="support2-attachment support2-attachment--image">
        <button
          type="button"
          className="support2-attachment__image-preview"
          onClick={() => onImageClick({ ...attachment, fileName })}
          title="Открыть изображение"
        >
          <img src={attachment.url} alt={fileName} loading="lazy" decoding="async" />
        </button>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="support2-attachment support2-attachment--video">
        <video src={attachment.url} controls preload="metadata" playsInline />
        <a href={attachment.url} target="_blank" rel="noreferrer">
          {fileName}
        </a>
      </div>
    );
  }

  return (
    <a
      className="support2-attachment support2-attachment--file"
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
    >
      <Paperclip size={16} aria-hidden="true" />
      <span>{fileName}</span>
      {kind === "zip" ? <small>ZIP</small> : null}
    </a>
  );
}

function readTalkMeCustomFields(): ReturnType<typeof buildTalkMeCustomFields> | undefined {
  const raw = getVpnTalkmeProfileRaw();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Parameters<typeof buildTalkMeCustomFields>[0];
    return buildTalkMeCustomFields(parsed);
  } catch {
    return undefined;
  }
}

const Chat = () => {
  const navigate = useNavigate();
  const { email, items, handleLogout } = useDashboardSidebarItems();
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [onlineCount, setOnlineCount] = useState<number | null>(null);
  const [operatorTyping, setOperatorTyping] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ChatAttachment | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  /** Отправленные сообщения, которых ещё нет в ответе Talk-Me. */
  const pendingMessagesRef = useRef<ChatMessage[]>([]);

  const handleAuthError = useCallback(() => {
    setError("Сессия истекла. Войдите снова.");
    navigate("/", { replace: true });
  }, [navigate]);

  const scrollMessagesToEnd = useCallback(() => {
    const container = messagesContainerRef.current;
    const endEl = messagesEndRef.current;
    if (!container || !endEl) return;

    const { overflowY } = window.getComputedStyle(container);
    if (overflowY === "auto" || overflowY === "scroll") {
      container.scrollTop = container.scrollHeight;
      return;
    }

    const rect = endEl.getBoundingClientRect();
    const viewHeight = window.visualViewport?.height ?? window.innerHeight;
    if (rect.bottom > viewHeight - 12) {
      window.scrollBy({ top: rect.bottom - viewHeight + 12, left: 0, behavior: "auto" });
    }
  }, []);

  const resizeDraftTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;

    const { maxHeight } = window.getComputedStyle(textarea);
    const parsedMaxHeight = Number.parseFloat(maxHeight);
    const hasMaxHeight = Number.isFinite(parsedMaxHeight);

    textarea.style.height = "auto";
    textarea.style.height = `${hasMaxHeight ? Math.min(textarea.scrollHeight, parsedMaxHeight) : textarea.scrollHeight}px`;
    textarea.style.overflowY = hasMaxHeight && textarea.scrollHeight > parsedMaxHeight ? "auto" : "hidden";
  }, []);

  /**
   * Ответ Talk-Me индексирует свежее сообщение с задержкой, поэтому только что
   * отправленные сообщения держим отдельно и подмешиваем в конец, пока они не
   * появятся в истории — иначе поллинг стирал бы их из списка.
   */
  const withPendingMessages = useCallback((loaded: ChatMessage[]): ChatMessage[] => {
    const stillPending = pendingMessagesRef.current.filter(
      (pending) => !loaded.some((message) => messageMatchesSentMessage(message, pending, null)),
    );
    pendingMessagesRef.current = stillPending;
    return stillPending.length > 0 ? [...loaded, ...stillPending] : loaded;
  }, []);

  const loadMessages = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setMessagesLoading(true);
      try {
        // Идентификация — на бэкенде: он выбирает посетителя Talk-Me по сессии
        // и читает диалог по `searchId`.
        const data = await talkmePost<MessagesResponse>(
          "/talkme/messages",
          { limit: 200 },
          handleAuthError,
        );
        if (!mountedRef.current) return;
        setMessages(withPendingMessages(Array.isArray(data.messages) ? data.messages : []));
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить сообщения");
      } finally {
        if (!silent) setMessagesLoading(false);
      }
    },
    [handleAuthError, withPendingMessages],
  );

  /**
   * После отправки Talk-Me отдаёт сообщение в истории не сразу, поэтому
   * несколько раз перезапрашиваем её с нарастающей паузой. Что не догнали —
   * доберёт обычный поллинг, optimistic-сообщение до этого остаётся на экране.
   */
  const syncMessagesAfterSend = useCallback(async (): Promise<void> => {
    for (const delay of CHAT_SEND_SYNC_DELAYS_MS) {
      if (!mountedRef.current || pendingMessagesRef.current.length === 0) return;
      await wait(delay);
      if (!mountedRef.current) return;
      await loadMessages({ silent: true });
    }
  }, [loadMessages]);

  const refreshMeta = useCallback(async () => {
    const requests: Promise<void>[] = [
      talkmePost<OperatorListResponse>("/talkme/operator-list", {}, handleAuthError)
        .then((data) => setOnlineCount(typeof data.onlineCount === "number" ? data.onlineCount : null))
        .catch(() => setOnlineCount(null)),
    ];

    requests.push(
      talkmePost<DialogStatusResponse>("/talkme/dialog-status", {}, handleAuthError)
        .then((data) => setStatusLabel(data.statusLabel || null))
        .catch(() => setStatusLabel(null)),
    );

    if (clientId) {
      requests.push(
        talkmePost<OperatorTypingResponse>(
          "/talkme/operator-typing-status",
          { clientId },
          handleAuthError,
        )
          .then((data) => setOperatorTyping(data.typing === true))
          .catch(() => setOperatorTyping(false)),
      );
    } else {
      setOperatorTyping(false);
    }

    await Promise.all(requests);
  }, [clientId, handleAuthError]);

  useEffect(() => {
    if (!email) return;

    let cancelled = false;

    talkmePost<ClientIdResponse>("/talkme/client-id", {}, handleAuthError)
      .then((data) => {
        if (cancelled) return;
        const syntheticClientId = typeof data.clientId === "string" ? data.clientId.trim() : "";
        if (!syntheticClientId) return;

        setClientId((prev) => prev || syntheticClientId);
        ensureTalkMeScript({ clientId: syntheticClientId });

        const syncClientInfo = () => {
          if (cancelled) return;
          setTalkMeClientInfo({
            email,
            custom: readTalkMeCustomFields(),
          });
        };
        syncClientInfo();
        window.setTimeout(syncClientInfo, 800);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [email, handleAuthError]);

  useEffect(() => {
    if (!email) return;

    let cancelled = false;
    fetch(`${apiBase}/announcement`)
      .then((r) => r.json() as Promise<{ text?: unknown }>)
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.text === "string" && data.text.trim()) {
          setAnnouncement(data.text.trim());
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email]);

  useEffect(() => {
    let cancelled = false;

    loadMessages({ silent: true }).finally(() => {
      if (!cancelled) setInitialLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [loadMessages]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    let messagesTimer: number | null = null;
    let metaTimer: number | null = null;

    const stopPolling = () => {
      if (messagesTimer !== null) {
        window.clearInterval(messagesTimer);
        messagesTimer = null;
      }
      if (metaTimer !== null) {
        window.clearInterval(metaTimer);
        metaTimer = null;
      }
    };

    const startPolling = () => {
      stopPolling();
      messagesTimer = window.setInterval(() => {
        void loadMessages({ silent: true });
      }, CHAT_MESSAGES_POLL_MS);
      metaTimer = window.setInterval(() => {
        void refreshMeta();
      }, CHAT_META_POLL_MS);
    };

    const syncPolling = () => {
      if (document.hidden) {
        stopPolling();
        return;
      }
      void loadMessages({ silent: true });
      void refreshMeta();
      startPolling();
    };

    syncPolling();
    document.addEventListener("visibilitychange", syncPolling);

    return () => {
      document.removeEventListener("visibilitychange", syncPolling);
      stopPolling();
    };
  }, [loadMessages, refreshMeta]);

  useEffect(() => {
    scrollMessagesToEnd();
  }, [messages, operatorTyping, scrollMessagesToEnd]);

  useEffect(() => {
    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    let animationFrame = 0;

    const update = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const height = visualViewport?.height ?? window.innerHeight;
        const top = visualViewport?.offsetTop ?? 0;
        root.style.setProperty("--chat-vh", `${Math.round(height)}px`);
        root.style.setProperty("--chat-vv-top", `${Math.round(top)}px`);
        scrollMessagesToEnd();
      });
    };

    update();
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--chat-vh");
      root.style.removeProperty("--chat-vv-top");
    };
  }, [scrollMessagesToEnd]);

  useEffect(() => {
    const nextPreviewUrls = new Set(
      messages
        .flatMap((message) => message.attachments?.map((attachment) => attachment.url) ?? [])
        .filter((url) => url.startsWith("blob:")),
    );

    previewUrlsRef.current.forEach((url) => {
      if (!nextPreviewUrls.has(url)) URL.revokeObjectURL(url);
    });
    previewUrlsRef.current = nextPreviewUrls;
  }, [messages]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    resizeDraftTextarea(textareaRef.current);
  }, [draft, resizeDraftTextarea]);

  useEffect(() => {
    if (!lightboxImage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxImage(null);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [lightboxImage]);

  const clearSelectedFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedFile(event.target.files?.[0] ?? null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    const fileToSend = selectedFile;
    if (!email || sending || (!text && !fileToSend)) return;

    const optimisticAttachment = fileToSend
      ? {
          url: URL.createObjectURL(fileToSend),
          fileName: fileToSend.name,
          mimeType: fileToSend.type,
          kind: getAttachmentKind({
            url: fileToSend.name,
            fileName: fileToSend.name,
            mimeType: fileToSend.type,
          }),
        }
      : null;

    const optimisticMessage: ChatMessage = {
      id: -Date.now(),
      text,
      sender: "client",
      operatorName: null,
      dateTime: new Date().toISOString(),
      status: "sending",
      attachments: optimisticAttachment ? [optimisticAttachment] : undefined,
    };

    setDraft("");
    clearSelectedFile();
    pendingMessagesRef.current = [...pendingMessagesRef.current, optimisticMessage];
    setMessages((prev) => [...prev, optimisticMessage]);
    setSending(true);
    setError(null);

    try {
      const attachment = fileToSend ? await uploadChatAttachment(fileToSend, handleAuthError) : null;
      if (fileToSend && !attachment?.url) {
        throw new Error("Файл загружен, но сервер не вернул ссылку");
      }
      const data = await talkmePost<SendResponse>(
        "/talkme/send",
        {
          text,
          attachmentUrl: attachment?.url || undefined,
          attachmentName: attachment?.fileName || fileToSend?.name || undefined,
          name: buildTalkMeVisitorName(),
          custom: readTalkMeCustomFields(),
        },
        handleAuthError,
      );

      if (data.clientId) {
        setClientId(data.clientId);
      }
      await syncMessagesAfterSend();
      await refreshMeta();
    } catch (err) {
      setDraft(text);
      setSelectedFile(fileToSend);
      pendingMessagesRef.current = pendingMessagesRef.current.filter(
        (message) => message.id !== optimisticMessage.id,
      );
      setMessages((prev) => prev.filter((message) => message.id !== optimisticMessage.id));
      setError(err instanceof Error ? err.message : "Не удалось отправить сообщение");
    } finally {
      setSending(false);
    }
  };

  const operatorMobileHint =
    onlineCount === null ? "Операторы онлайн: проверяем" : `Операторы онлайн: ${onlineCount}`;

  return (
    <LandingShell
      className={`landing-root--with-sidebar landing-root--chat${
        composerFocused ? " landing-root--chat-composer-focused" : ""
      }`}
    >
      <DashboardSidebar
        items={items}
        onLogout={handleLogout}
        email={email || undefined}
        mobileTitle="Диалог с оператором"
        mobileHint={operatorMobileHint}
      />

      <main>
        <section className="app-page">
          <div className="container">
            {announcement ? (
              <section
                className="support-card support-announcement support-announcement--page-start"
                role="status"
                aria-label="Важное объявление"
              >
                <h2 className="support-card__title">Важное объявление</h2>
                <p className="support-card__subtitle whitespace-pre-wrap">{announcement}</p>
              </section>
            ) : null}

            <div className="app-page__eyebrow">Поддержка 220v</div>
            <h1 className="app-page__title">Чат с поддержкой</h1>
            <div className="support-meta__item support-meta__item--primary support-email-highlight">
              <p className="support-meta__note support-email-highlight__note">
                Пока онлайн-чат работает с перебоями — пишите на почту:
              </p>
              <a href="mailto:support@220v.shop" className="support-meta__value support-meta__link">
                support@220v.shop
              </a>
            </div>

            <div className="support-layout support2-layout">
              <section className="support-card support2-chat">
                <div className="support2-chat__header">
                  <div className="support2-chat__title-wrap">
                    <h2 className="support-card__title">Диалог с оператором</h2>
                  </div>
                  <div className="support2-chat__badges" aria-label="Статус чата">
                    <span className="support2-chat__badge support2-chat__badge--operators">
                      {onlineCount === null
                        ? "Операторы: проверяем"
                        : onlineCount > 0
                          ? `Операторы онлайн: ${onlineCount}`
                          : "Операторы офлайн"}
                    </span>
                    {statusLabel ? <span className="support2-chat__badge">{statusLabel}</span> : null}
                  </div>
                </div>

                {error ? (
                  <div className="support2-chat__error" role="alert">
                    {error}
                  </div>
                ) : null}

                <div
                  ref={messagesContainerRef}
                  className="support2-chat__messages"
                  data-dashboard-mobile-scroll
                  aria-live="polite"
                >
                  {initialLoading ? (
                    <div className="support2-chat__state">
                      <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
                      Подключаемся к чату...
                    </div>
                  ) : messages.length > 0 ? (
                    messages.map((message) => {
                      const displayMessage = parseMessageForDisplay(message);

                      return (
                        <article
                          key={message.id}
                          className={`support2-message support2-message--${message.sender}`}
                        >
                          <div className="support2-message__bubble">
                            <div className="support2-message__meta">
                              <span>{message.sender === "operator" ? message.operatorName || "Оператор" : "Вы"}</span>
                              {message.dateTime ? <time>{formatMessageTime(message.dateTime)}</time> : null}
                            </div>
                            {displayMessage.text ? <MessageText text={displayMessage.text} /> : null}
                            {displayMessage.attachments.length > 0 ? (
                              <div className="support2-message__attachments">
                                {displayMessage.attachments.map((attachment) => (
                                  <span className="support2-message__attachment-item" key={attachment.url}>
                                    <ChatAttachmentPreview
                                      attachment={attachment}
                                      onImageClick={setLightboxImage}
                                    />
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <div className="support2-chat__state">
                      Напишите первое сообщение, и мы откроем диалог с оператором.
                    </div>
                  )}

                  {operatorTyping ? (
                    <div className="support2-chat__typing">Оператор печатает...</div>
                  ) : null}
                  <div ref={messagesEndRef} />
                </div>

                <form className="support2-chat__form" onSubmit={handleSubmit}>
                  {selectedFile ? (
                    <div className="support2-chat__file" title={selectedFile.name}>
                      <span>{selectedFile.name}</span>
                      <button type="button" onClick={clearSelectedFile} aria-label="Убрать файл" disabled={sending}>
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                  <div className="support2-chat__input-bar">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,video/*,.zip"
                      className="support2-chat__file-input"
                      onChange={handleFileChange}
                      disabled={!email || sending}
                    />
                    <button
                      type="button"
                      className="support2-chat__attach"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!email || sending}
                      aria-label="Прикрепить файл"
                      title="Прикрепить файл"
                    >
                      <Paperclip size={18} aria-hidden="true" />
                    </button>
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        resizeDraftTextarea(event.currentTarget);
                      }}
                      placeholder="Опишите вопрос..."
                      enterKeyHint="send"
                      rows={1}
                      disabled={!email || sending}
                      onFocus={() => setComposerFocused(true)}
                      onBlur={() => setComposerFocused(false)}
                      onKeyDown={(event) => {
                        const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey || (coarsePointer && !event.shiftKey))) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <button
                      type="submit"
                      className="support2-chat__send"
                      disabled={!email || (!draft.trim() && !selectedFile) || sending}
                      aria-label="Отправить"
                      title="Отправить"
                    >
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send size={18} />}
                    </button>
                  </div>
                </form>

                {messagesLoading ? <p className="support2-chat__sync">Обновляем сообщения...</p> : null}
              </section>
            </div>
          </div>
        </section>
      </main>

      {lightboxImage ? (
        <div
          className="support2-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightboxImage.fileName || "Изображение"}
          onClick={() => setLightboxImage(null)}
        >
          <button
            type="button"
            className="support2-lightbox__close"
            onClick={() => setLightboxImage(null)}
            aria-label="Закрыть"
          >
            <X size={22} aria-hidden="true" />
          </button>
          <figure className="support2-lightbox__figure" onClick={(event) => event.stopPropagation()}>
            <img
              src={lightboxImage.url}
              alt={lightboxImage.fileName || "Изображение"}
              decoding="async"
            />
            <figcaption className="support2-lightbox__caption">
              <span>{lightboxImage.fileName || getFileNameFromUrl(lightboxImage.url)}</span>
              <a href={lightboxImage.url} target="_blank" rel="noreferrer">
                Открыть оригинал
              </a>
            </figcaption>
          </figure>
        </div>
      ) : null}

      <LandingFooter />
    </LandingShell>
  );
};

export default Chat;
