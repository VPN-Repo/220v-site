import { describe, expect, it } from "vitest";
import { checkEmailTypo, cleanLocalPart, damerauLevenshtein, suggestEmailFix } from "@/lib/emailTypos";

describe("damerauLevenshtein", () => {
  it("counts an adjacent swap as one edit", () => {
    expect(damerauLevenshtein("gmial.com", "gmail.com")).toBe(1);
    expect(damerauLevenshtein("gmail.com", "gmail.com")).toBe(0);
    expect(damerauLevenshtein("mail.ry", "mail.ru")).toBe(1);
    expect(damerauLevenshtein("", "abc")).toBe(3);
  });
});

describe("cleanLocalPart", () => {
  it("strips trailing separators, leading dots, doubled dots and spaces", () => {
    expect(cleanLocalPart("ivan-")).toBe("ivan");
    expect(cleanLocalPart("ivan._")).toBe("ivan");
    expect(cleanLocalPart(".ivan")).toBe("ivan");
    expect(cleanLocalPart("iv..an")).toBe("iv.an");
    expect(cleanLocalPart("ivan petrov")).toBe("ivanpetrov");
  });
});

describe("suggestEmailFix", () => {
  it.each([
    ["ivan@gmial.com", "ivan@gmail.com"],
    ["ivan@gmai.com", "ivan@gmail.com"],
    ["ivan@gmail.con", "ivan@gmail.com"],
    ["ivan@gmail.cmo", "ivan@gmail.com"],
    ["ivan@gmail.ru", "ivan@gmail.com"],
    ["ivan@gmail", "ivan@gmail.com"],
    ["ivan@gmailcom", "ivan@gmail.com"],
    ["ivan@gmail,com", "ivan@gmail.com"],
    ["ivan@gmail.com.", "ivan@gmail.com"],
    ["ivan@mail.ry", "ivan@mail.ru"],
    ["ivan@mial.ru", "ivan@mail.ru"],
    ["ivan@yandex.ry", "ivan@yandex.ru"],
    ["ivan@yadex.ru", "ivan@yandex.ru"],
    ["ivan@ya.ry", "ivan@ya.ru"],
    ["ivan@bk.ry", "ivan@bk.ru"],
    ["ivan@lsit.ru", "ivan@list.ru"],
    ["ivan@inbx.ru", "ivan@inbox.ru"],
    ["ivan@rambler.com", "ivan@rambler.ru"],
    ["ivan@ramblr.ru", "ivan@rambler.ru"],
    ["ivan@icloud.ru", "ivan@icloud.com"],
    ["ivan@iclod.com", "ivan@icloud.com"],
    ["ivan@outlok.com", "ivan@outlook.com"],
    ["ivan@hotmial.com", "ivan@hotmail.com"],
    ["ivan@yahooo.com", "ivan@yahoo.com"],
    ["ivan@proton.com", "ivan@proton.me"],
    ["ivan@internet.ry", "ivan@internet.ru"],
    ["ivan-@gmail.com", "ivan@gmail.com"],
    ["ivan.@mail.ru", "ivan@mail.ru"],
    ["ivan_@yandex.ru", "ivan@yandex.ru"],
    ["iv..an@mail.ru", "iv.an@mail.ru"],
    ["ivan petrov@mail.ru", "ivanpetrov@mail.ru"],
    ["ivan-@mail.ry", "ivan@mail.ru"],
    ["  Ivan@GMIAL.com ", "ivan@gmail.com"],
  ])("%s -> %s", (input, expected) => {
    expect(suggestEmailFix(input)).toBe(expected);
  });

  it.each([
    "ivan@gmail.com",
    "ivan.petrov@mail.ru",
    "ivan-petrov@yandex.ru",
    "ivan_petrov@bk.ru",
    "ivan@ya.ru",
    "ivan@list.ru",
    "ivan@inbox.ru",
    "ivan@internet.ru",
    "ivan@proton.me",
    "ivan@protonmail.com",
    "ivan@pm.me",
    "ivan@icloud.com",
    "ivan@me.com",
    "ivan@mail.com",
    "ivan@email.com",
    "ivan@ymail.com",
    "ivan@googlemail.com",
    "ivan@gmx.com",
    "ivan@yandex.com",
    "ivan@yandex.by",
    "ivan@yandex.kz",
    "ivan@inbox.lv",
    "ivan@mail.ua",
    "ivan@ok.ru",
    "ivan@vk.com",
    "ivan@ukr.net",
    "ivan@yahoo.co.uk",
    "ivan@hotmail.fr",
    "ivan@live.com",
    "ivan@happ.su",
    "ivan@example.com",
    "ivan@company.ru",
    "ivan@university.edu",
    "ivan@my-startup.io",
  ])("leaves %s alone", (input) => {
    expect(suggestEmailFix(input)).toBeNull();
  });

  it("ignores incomplete or empty input", () => {
    expect(suggestEmailFix("")).toBeNull();
    expect(suggestEmailFix("ivan")).toBeNull();
    expect(suggestEmailFix("ivan@")).toBeNull();
    expect(suggestEmailFix("@gmail.com")).toBeNull();
    expect(suggestEmailFix("-@gmail.com")).toBeNull();
  });

  it("is idempotent: a suggestion never triggers another one", () => {
    for (const input of ["ivan-@gmial.com", "iv..an@mail.ry", "ivan@gmail.ru", "ivan@bk.ry"]) {
      const fixed = suggestEmailFix(input);
      expect(fixed).not.toBeNull();
      expect(suggestEmailFix(fixed as string)).toBeNull();
    }
  });
});

describe("checkEmailTypo", () => {
  it("describes local-part junk in plain words", () => {
    expect(checkEmailTypo("ivan-@gmail.com")).toEqual({
      suggestion: "ivan@gmail.com",
      domainChanged: false,
      localIssues: ["лишний «-» перед @"],
    });
    expect(checkEmailTypo("ivan._@mail.ru")?.localIssues).toEqual(["лишние «._» перед @"]);
    expect(checkEmailTypo(".ivan@mail.ru")?.localIssues).toEqual(["лишняя точка в начале"]);
    expect(checkEmailTypo("iv..an@mail.ru")?.localIssues).toEqual(["две точки подряд"]);
    expect(checkEmailTypo("ivan petrov@mail.ru")?.localIssues).toEqual(["пробел в адресе"]);
  });

  it("marks domain corrections separately", () => {
    expect(checkEmailTypo("ivan@gmial.com")).toEqual({
      suggestion: "ivan@gmail.com",
      domainChanged: true,
      localIssues: [],
    });
    expect(checkEmailTypo("ivan-@mail.ry")).toMatchObject({ domainChanged: true, localIssues: ["лишний «-» перед @"] });
  });

  it("returns null for valid addresses", () => {
    expect(checkEmailTypo("ivan.petrov@mail.ru")).toBeNull();
    expect(checkEmailTypo("ivan@company.ru")).toBeNull();
  });
});
