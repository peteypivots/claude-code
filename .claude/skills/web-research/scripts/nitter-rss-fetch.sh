#!/bin/bash
# nitter-rss-fetch.sh — Fetch and parse Nitter RSS feeds into JSON
#
# Usage:
#   nitter-rss-fetch.sh search "bitcoin"              # search tweets
#   nitter-rss-fetch.sh search "from:elonmusk"        # user's tweets via search
#   nitter-rss-fetch.sh user "elonmusk"               # user timeline RSS
#   nitter-rss-fetch.sh search "bitcoin" cursor123     # paginate with cursor
#
# Output: JSON array of posts, one per line (JSONL), each with:
#   {tweet_id, username, text, html_description, pub_date, permalink,
#    mentions[], hashtags[], quoted_user, reply_to_user, media_urls[]}
#
# Environment:
#   NITTER_URL  — Nitter base URL (default: http://localhost:8081)

set -euo pipefail

MODE="${1:?Usage: nitter-rss-fetch.sh <search|user> <query|username> [cursor]}"
QUERY="${2:?Missing query or username}"
CURSOR="${3:-}"

NITTER_URL="${NITTER_URL:-http://localhost:8081}"

# ── Build URL ──────────────────────────────────────────────
build_url() {
  local url=""
  case "$MODE" in
    search)
      local encoded_q
      encoded_q=$(printf '%s' "$QUERY" | jq -sRr @uri)
      url="${NITTER_URL}/search/rss?q=${encoded_q}&f=tweets"
      if [ -n "$CURSOR" ]; then
        url="${url}&cursor=${CURSOR}"
      fi
      ;;
    user)
      local username
      username=$(printf '%s' "$QUERY" | sed 's/^@//')
      url="${NITTER_URL}/${username}/rss"
      if [ -n "$CURSOR" ]; then
        url="${url}?cursor=${CURSOR}"
      fi
      ;;
    *)
      echo '{"error": "Unknown mode: '"$MODE"'. Use: search, user"}' >&2
      exit 1
      ;;
  esac
  echo "$url"
}

# ── Fetch RSS ──────────────────────────────────────────────
fetch_rss() {
  local url="$1"
  local response_file
  response_file=$(mktemp)
  local header_file
  header_file=$(mktemp)

  local http_code
  http_code=$(curl -sf -w '%{http_code}' \
    -D "$header_file" \
    -o "$response_file" \
    --max-time 15 \
    "$url" 2>/dev/null) || http_code="000"

  if [ "$http_code" != "200" ]; then
    echo "{\"error\": \"HTTP ${http_code}\", \"url\": \"$url\"}" >&2
    rm -f "$response_file" "$header_file"
    return 1
  fi

  # Extract Min-Id cursor from headers for pagination
  local min_id
  min_id=$(grep -i 'min-id' "$header_file" 2>/dev/null | sed 's/.*: *//' | tr -d '\r\n' || echo "")

  cat "$response_file"
  rm -f "$response_file"

  # Output cursor to stderr for caller to capture
  if [ -n "$min_id" ]; then
    echo "CURSOR:${min_id}" >&2
  fi
  rm -f "$header_file"
}

# ── Parse RSS XML → JSONL ─────────────────────────────────
# Uses perl for reliable XML parsing without xmllint dependency
parse_rss() {
  local xml="$1"
  local source_query="$2"

  # Extract items using perl — handles multiline <item> blocks
  echo "$xml" | perl -0777 -ne '
    use strict;
    use warnings;

    # Find all <item>...</item> blocks
    while (/<item>(.*?)<\/item>/gs) {
      my $item = $1;

      # Extract fields
      my ($title) = $item =~ /<title><!\[CDATA\[(.*?)\]\]><\/title>/s;
      $title //= ($item =~ /<title>(.*?)<\/title>/s) ? $1 : "";

      my ($desc) = $item =~ /<description><!\[CDATA\[(.*?)\]\]><\/description>/s;
      $desc //= ($item =~ /<description>(.*?)<\/description>/s) ? $1 : "";

      my ($pubdate) = $item =~ /<pubDate>(.*?)<\/pubDate>/s;
      $pubdate //= "";

      my ($guid) = $item =~ /<guid.*?>(.*?)<\/guid>/s;
      $guid //= "";

      my ($link) = $item =~ /<link>(.*?)<\/link>/s;
      $link //= "";

      my ($creator) = $item =~ /<dc:creator>(.*?)<\/dc:creator>/s;
      $creator //= "";
      $creator =~ s/^\@//;  # strip leading @

      # Extract tweet_id from guid (snowflake ID) or link
      my $tweet_id = "";
      if ($guid =~ /\/status\/(\d+)/ || $link =~ /\/status\/(\d+)/) {
        $tweet_id = $1;
      } elsif ($guid =~ /^(\d+)$/) {
        $tweet_id = $1;
      }

      # Extract mentions from description HTML: @username links
      my @mentions;
      while ($desc =~ /\@([\w]+)/g) {
        push @mentions, lc($1) unless lc($1) eq lc($creator);
      }
      # Deduplicate
      my %seen_m; @mentions = grep { !$seen_m{$_}++ } @mentions;

      # Extract hashtags
      my @hashtags;
      while ($desc =~ /#([\w]+)/g) {
        push @hashtags, lc($1);
      }
      my %seen_h; @hashtags = grep { !$seen_h{$_}++ } @hashtags;

      # Extract quoted user (nitter quote format: <a href="/username/status/...">)
      my $quoted_user = "";
      if ($desc =~ /class="quote-link".*?href="\/([\w]+)\//) {
        $quoted_user = lc($1);
      } elsif ($desc =~ /class="quote".*?\@([\w]+)/) {
        $quoted_user = lc($1);
      }

      # Extract reply-to (R to @username pattern in title)
      my $reply_to = "";
      if ($title =~ /^R to \@([\w]+)/) {
        $reply_to = lc($1);
      }

      # Extract media URLs from description
      my @media;
      while ($desc =~ /(?:src|href)="(https?:\/\/[^"]*?\.(?:jpg|jpeg|png|gif|mp4|webp|webm)[^"]*)"/gi) {
        push @media, $1;
      }
      my %seen_media; @media = grep { !$seen_media{$_}++ } @media;

      # Clean text: strip HTML from description for plain text
      my $text = $desc;
      $text =~ s/<[^>]+>//g;         # strip tags
      $text =~ s/&amp;/&/g;
      $text =~ s/&lt;/</g;
      $text =~ s/&gt;/>/g;
      $text =~ s/&quot;/"/g;
      $text =~ s/&#39;/'"'"'/g;
      $text =~ s/\s+/ /g;            # collapse whitespace
      $text =~ s/^\s+|\s+$//g;       # trim

      # Escape for JSON
      foreach ($title, $text, $desc, $pubdate, $link, $creator, $tweet_id, $quoted_user, $reply_to) {
        $_ =~ s/\\/\\\\/g;
        $_ =~ s/"/\\"/g;
        $_ =~ s/\n/\\n/g;
        $_ =~ s/\r//g;
        $_ =~ s/\t/\\t/g;
      }

      my $mentions_json = "[" . join(",", map { "\"$_\"" } @mentions) . "]";
      my $hashtags_json = "[" . join(",", map { "\"$_\"" } @hashtags) . "]";
      my $media_json = "[" . join(",", map { s/\\/\\\\/g; s/"/\\"/g; "\"$_\"" } @media) . "]";

      # Source query (escaped)
      my $sq = $ENV{SOURCE_QUERY} // "";
      $sq =~ s/\\/\\\\/g;
      $sq =~ s/"/\\"/g;

      print "{\"tweet_id\":\"$tweet_id\",\"username\":\"" . lc($creator) . "\",\"text\":\"$text\",\"html_description\":\"$desc\",\"pub_date\":\"$pubdate\",\"permalink\":\"$link\",\"mentions\":$mentions_json,\"hashtags\":$hashtags_json,\"quoted_user\":\"$quoted_user\",\"reply_to_user\":\"$reply_to\",\"media_urls\":$media_json,\"source_query\":\"$sq\"}\n";
    }
  '
}

# ── Main ───────────────────────────────────────────────────
URL=$(build_url)
RSS_XML=$(fetch_rss "$URL") || exit 1

if [ -z "$RSS_XML" ]; then
  echo '{"error": "Empty RSS response"}' >&2
  exit 1
fi

# Check if it's actually XML (not an error page)
if ! echo "$RSS_XML" | head -5 | grep -qi '<rss\|<\?xml'; then
  echo '{"error": "Response is not RSS/XML", "preview": "'"$(echo "$RSS_XML" | head -3 | tr '\n' ' ' | head -c 200)"'"}' >&2
  exit 1
fi

# Parse and output JSONL
export SOURCE_QUERY="$QUERY"
PARSED=$(parse_rss "$RSS_XML" "$QUERY")

if [ -z "$PARSED" ]; then
  echo '{"posts": 0, "query": "'"$QUERY"'", "mode": "'"$MODE"'"}' >&2
  exit 0
fi

# Output JSONL (one JSON object per line)
echo "$PARSED"

# Summary to stderr
POST_COUNT=$(echo "$PARSED" | wc -l)
echo "{\"posts\": $POST_COUNT, \"query\": \"$QUERY\", \"mode\": \"$MODE\"}" >&2
