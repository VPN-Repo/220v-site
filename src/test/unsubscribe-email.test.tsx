import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import UnsubscribeEmail from "@/pages/UnsubscribeEmail";

function renderUnsubscribe(path = "/unsubscribe-email?t=signed-token") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/unsubscribe-email" element={<UnsubscribeEmail />} />
        <Route path="/" element={<div>Главная</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("UnsubscribeEmail", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows invalid state when token is missing", () => {
    renderUnsubscribe("/unsubscribe-email");

    expect(screen.getByText("Ссылка недействительна")).toBeInTheDocument();
  });

  it("requires a reason before opening confirmation", () => {
    renderUnsubscribe();

    fireEvent.click(screen.getByRole("button", { name: /продолжить/i }));

    expect(screen.getByText("Укажите причину отписки")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires text for other reason", () => {
    renderUnsubscribe();

    fireEvent.click(screen.getByLabelText(/^Другое/));
    fireEvent.click(screen.getByRole("button", { name: /продолжить/i }));

    expect(screen.getByText("Укажите причину отписки")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires confirmation checkbox before submit", () => {
    renderUnsubscribe();

    fireEvent.click(screen.getByLabelText(/Мне это неактуально/i));
    fireEvent.click(screen.getByRole("button", { name: /продолжить/i }));
    fireEvent.click(screen.getByRole("button", { name: /подтвердить отписку/i }));

    expect(screen.getAllByText("Подтвердите отписку").length).toBeGreaterThan(1);
  });

  it("submits unsubscribe request and shows success state", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderUnsubscribe();

    fireEvent.click(screen.getByLabelText(/Мне это неактуально/i));
    fireEvent.click(screen.getByRole("button", { name: /продолжить/i }));
    fireEvent.click(screen.getByLabelText(/Я понимаю/i));
    fireEvent.click(screen.getByRole("button", { name: /подтвердить отписку/i }));

    await screen.findByText("Вы отписаны от email-рассылки");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/email/unsubscribe");
    expect(JSON.parse(String(init?.body))).toEqual({
      token: "signed-token",
      reason: "not_relevant",
      otherReason: "",
      consent: true,
    });
  });
});
