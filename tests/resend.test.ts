import { describe, expect, test, vi } from "vitest";

// Mock nodemailer transport chain
const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-msg-id" });
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
  createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
}));

import { sendResendEmail } from "../src/publishers/resend.js";

describe("sendResendEmail", () => {
  test("calls nodemailer with correct parameters", async () => {
    mockSendMail.mockClear();

    const result = await sendResendEmail(
      "smtp.126.com", 465, true,
      "user@126.com", "pass",
      "Paper Tracker <from@126.com>",
      ["a@test.com", "b@test.com"],
      "Test Subject",
      "<h1>HTML Content</h1>"
    );

    expect(result).toEqual({ sent: true, messageId: "test-msg-id" });

    const nodemailer = await import("nodemailer");
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "smtp.126.com",
      port: 465,
      secure: true,
      auth: { user: "user@126.com", pass: "pass" },
    });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: "Paper Tracker <from@126.com>",
      to: "a@test.com, b@test.com",
      subject: "Test Subject",
      html: "<h1>HTML Content</h1>",
    });
  });

  test("skips when recipients list is empty", async () => {
    mockSendMail.mockClear();

    const result = await sendResendEmail(
      "smtp.126.com", 465, true,
      "user@126.com", "pass",
      "from@126.com",
      [],
      "Subject",
      "<h1>Hello</h1>"
    );

    expect(result).toEqual({ sent: false, reason: "no recipients" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("retries on failure", async () => {
    mockSendMail
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ messageId: "retry-success" });

    const result = await sendResendEmail(
      "smtp.126.com", 465, true,
      "user@126.com", "pass",
      "from@126.com",
      ["a@test.com"],
      "Subject",
      "<h1>Content</h1>"
    );

    expect(result).toEqual({ sent: true, messageId: "retry-success" });
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });
});
