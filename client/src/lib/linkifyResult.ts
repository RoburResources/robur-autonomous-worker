export type LinkedResultToken = {
  text: string;
  href?: string;
};

const RESULT_URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

function trimUnbalancedClosing(
  value: string,
  opening: string,
  closing: string
): string {
  let openingCount = 0;
  let closingCount = 0;
  for (const character of value) {
    if (character === opening) openingCount += 1;
    if (character === closing) closingCount += 1;
  }

  let result = value;
  while (result.endsWith(closing) && closingCount > openingCount) {
    result = result.slice(0, -1);
    closingCount -= 1;
  }
  return result;
}

function trimTrailingLinkSyntax(value: string): string {
  let result = value;
  let previous = "";

  while (result !== previous) {
    previous = result;
    result = result.replace(/[*`~]+$/g, "").replace(/[.,;:!?]+$/g, "");
    result = trimUnbalancedClosing(result, "(", ")");
    result = trimUnbalancedClosing(result, "[", "]");
    result = trimUnbalancedClosing(result, "{", "}");
  }

  return result;
}

export function linkifyResult(value: string): LinkedResultToken[] {
  const tokens = value
    .split(RESULT_URL_PATTERN)
    .filter(part => part.length > 0)
    .flatMap(part => {
      if (!/^https?:\/\//.test(part)) {
        return [{ text: part }];
      }

      const href = trimTrailingLinkSyntax(part);
      if (!href) {
        return [{ text: part }];
      }

      const suffix = part.slice(href.length);
      return suffix
        ? [{ text: href, href }, { text: suffix }]
        : [{ text: href, href }];
    });

  return tokens.reduce<LinkedResultToken[]>((result, token) => {
    const previous = result.at(-1);
    if (!token.href && previous && !previous.href) {
      previous.text += token.text;
    } else {
      result.push({ ...token });
    }
    return result;
  }, []);
}
