import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The `web_search` tool — a live-search fallback that needs no MCP server
 * configured in ~/.claude.json.
 *
 * JARVIS already reaches real search through optional servers (exa, serper,
 * serpapi) when one is set up there — see the README. This is for the machine
 * where none is, so "what's happening in AI this week" works the moment a
 * SERPER_API_KEY is exported, with no ~/.claude.json edit at all.
 *
 * Same in-process pattern as ui.mjs and panels.mjs: one SDK MCP server, one
 * tool, no subprocess. Unlike those, this one makes an outbound network call —
 * to Serper.dev, not to anything the user said — which is exactly the kind of
 * tool decideTool's READ_ONLY_MCP allowlist in server.mjs exists for: a lookup,
 * not an action.
 */

const SEARCH_DESCRIPTION = `Search the live web.

Use this for anything that depends on current information: news, prices,
scores, schedules, "what happened with X", or anything you are not confident
is still true. Returns real titles, snippets and source URLs from a live
search — never invent a result, a headline or a link. If this tool reports
that search isn't configured, say so plainly rather than answering as if you
had looked something up.

Speak only a short summary of what you find; a URL is for the display, never
for reading aloud.`

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Serper.dev's free tier is 2,500 queries, no card required — the lowest
 *  -friction real search API for a machine with no MCP server set up yet. */
const SERPER_URL = 'https://google.serper.dev/search'

export function searchServer() {
  return createSdkMcpServer({
    name: 'jarvis_search',
    version: '1.0.0',
    instructions:
      'Live web search for anything time-sensitive or uncertain. Refuses ' +
      'plainly, rather than guessing, when no key is configured.',
    tools: [
      tool(
        'web_search',
        SEARCH_DESCRIPTION,
        {
          query: z.string().min(1).describe('What to search for, in plain words.'),
          num: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .catch(5)
            .describe('How many results to return. Default 5.'),
        },
        async (args) => {
          const key = process.env.SERPER_API_KEY
          if (!key) {
            // Not a dead end: the built-in WebSearch tool is always allowed
            // (see READ_ONLY_BUILTINS in server.mjs) and needs no key. Telling
            // the model to give up here made every news question come back as
            // "live search is unavailable" even though a working search sat
            // right beside this one.
            return refuse(
              'This search backend has no SERPER_API_KEY. Use the built-in ' +
                'WebSearch tool for this query instead. Only if that fails ' +
                'too, say plainly that live search is unavailable rather than ' +
                'answering as if you had searched.',
            )
          }

          const query = String(args.query ?? '').trim()
          if (!query) return refuse('No query was given to search for.')
          const num = Math.min(10, Math.max(1, Number(args.num) || 5))

          let res
          try {
            res = await fetch(SERPER_URL, {
              method: 'POST',
              headers: {
                'X-API-KEY': key,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ q: query, num }),
              signal: AbortSignal.timeout(10_000),
            })
          } catch (err) {
            return refuse(`The search request failed: ${err?.message ?? err}`)
          }

          if (!res.ok) {
            return refuse(
              `The search provider returned an error (${res.status}). ` +
                'Say search failed rather than guessing at results.',
            )
          }

          let data
          try {
            data = await res.json()
          } catch {
            return refuse('The search provider returned something unreadable.')
          }

          const organic = Array.isArray(data?.organic) ? data.organic.slice(0, num) : []
          if (!organic.length) {
            return ok(`No results found for "${query}".`)
          }

          const lines = organic.map((r, i) => {
            const title = String(r.title ?? 'Untitled').trim()
            const snippet = String(r.snippet ?? '').trim()
            const link = String(r.link ?? '').trim()
            return `${i + 1}. ${title}\n   ${snippet}\n   ${link}`
          })

          // Google's "answer box" — a direct fact Serper has already extracted
          // (a definition, a score, a conversion). Worth surfacing first when
          // it's there, since it's often the entire answer the user wanted.
          const answer = data?.answerBox?.answer || data?.answerBox?.snippet
          const header = answer ? `Direct answer: ${String(answer).trim()}\n\n` : ''

          return ok(`${header}Results for "${query}":\n\n${lines.join('\n\n')}`)
        },
      ),
    ],
  })
}
