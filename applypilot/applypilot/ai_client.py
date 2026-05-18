"""
Unified AI client — currently using Claude (claude-sonnet-4-20250514).
To switch back to OpenAI, uncomment the OpenAI block and comment out the Anthropic block.
"""
import os

# ── Claude (active) ───────────────────────────────────────────────────────────
import anthropic as _anthropic

_client = _anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
_MODEL = "claude-sonnet-4-20250514"

# ── OpenAI (swap-in) ──────────────────────────────────────────────────────────
# from openai import OpenAI as _OpenAIClient
# _client = _OpenAIClient(api_key=os.environ["OPENAI_API_KEY"])
# _MODEL = "gpt-4o"
# _PROVIDER = "openai"
# ─────────────────────────────────────────────────────────────────────────────

_PROVIDER = "anthropic"


def chat(
    system: str,
    user: str,
    temperature: float = 0.4,
    max_tokens: int = 4096,
    json_mode: bool = False,
) -> str:
    """Send a chat request and return the text content."""
    if _PROVIDER == "anthropic":
        # Claude doesn't have a native json_mode flag — instruct via system prompt
        sys_prompt = system + "\n\nReturn ONLY valid JSON." if json_mode else system
        resp = _client.messages.create(
            model=_MODEL,
            max_tokens=max_tokens,
            temperature=temperature,
            system=sys_prompt,
            messages=[{"role": "user", "content": user}],
        )
        return resp.content[0].text.strip()

    # ── OpenAI path ───────────────────────────────────────────────────────────
    # kwargs: dict = dict(
    #     model=_MODEL,
    #     messages=[
    #         {"role": "system", "content": system},
    #         {"role": "user", "content": user},
    #     ],
    #     temperature=temperature,
    #     max_tokens=max_tokens,
    # )
    # if json_mode:
    #     kwargs["response_format"] = {"type": "json_object"}
    # resp = _client.chat.completions.create(**kwargs)
    # return resp.choices[0].message.content.strip()
    raise RuntimeError("Unknown provider")
