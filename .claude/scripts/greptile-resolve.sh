#!/bin/bash
# Greptile Review Thread Resolution Tool
# Uses GitHub GraphQL API to systematically resolve review threads
# Uses GitHub REST API to reply to review comments

set -e

# Colors for output (defined before use)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Auto-detect repository from git config
detect_repo() {
    local repo_info
    repo_info=$(gh repo view --json owner,name 2>/dev/null) || {
        echo -e "${RED}Error: Not in a git repository or gh CLI not authenticated${NC}"
        echo "Run: gh auth login"
        exit 1
    }

    OWNER=$(echo "$repo_info" | jq -r '.owner.login')
    REPO=$(echo "$repo_info" | jq -r '.name')

    if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
        echo -e "${RED}Error: Could not detect repository${NC}"
        exit 1
    fi
}

# Initialize repo detection
detect_repo

# Check for jq dependency
# Note: exit 1 is intentional - script cannot function without jq for JSON parsing
check_jq() {
    if ! command -v jq &> /dev/null; then
        echo -e "${RED}Error: jq is required but not installed${NC}"
        echo ""
        echo "This script requires jq for JSON parsing and cannot continue without it."
        echo ""
        echo "Please install jq:"
        echo "  • Ubuntu/Debian: sudo apt-get install jq"
        echo "  • macOS: brew install jq"
        echo "  • Windows: choco install jq"
        echo "  • Or download from: https://jqlang.github.io/jq/download/"
        echo ""
        exit 1
    fi
}

usage() {
    cat <<EOF
Usage: $(basename "$0") <command> <pr-number> [options]

Commands:
    list <pr-number>                    List all review threads
    list <pr-number> --unresolved       List only unresolved threads
    reply <pr-number> <comment-id> <message>  Reply to a review comment
    resolve <pr-number> <thread-id>     Resolve a specific thread
    reply-and-resolve <pr-number> <comment-id> <thread-id> <message>  Reply and resolve in one step
    resolve-all <pr-number>             Resolve ALL unresolved Greptile threads
    stats <pr-number>                   Show resolution statistics

Examples:
    $(basename "$0") list 24
    $(basename "$0") list 24 --unresolved
    $(basename "$0") reply 24 2787717459 "Fixed in commit abc123"
    $(basename "$0") resolve 24 PRRT_kwDORErEU85tuh6I
    $(basename "$0") reply-and-resolve 24 2787717459 PRRT_kwDORErEU85tuh6I "Fixed in commit abc123"
    $(basename "$0") resolve-all 24
    $(basename "$0") stats 24

Comment IDs (databaseId) and Thread IDs are shown in the list command output.
EOF
    exit 1
}

# Fetch all review threads for a PR (with pagination)
fetch_threads() {
    local pr_number="$1"
    local all_threads="[]"
    local has_next_page=true
    local end_cursor="null"

    while [ "$has_next_page" = "true" ]; do
        local response
        if [ "$end_cursor" != "null" ]; then
            response=$(gh api graphql -f owner="$OWNER" -f repo="$REPO" -F prNumber="$pr_number" -f after="$end_cursor" -f query='
                query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
                repository(owner: $owner, name: $repo) {
                    pullRequest(number: $prNumber) {
                        reviewThreads(first: 100, after: $after) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            nodes {
                                id
                                isResolved
                                comments(first: 1) {
                                    nodes {
                                        databaseId
                                        author { login }
                                        body
                                        path
                                        line
                                        createdAt
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ')
        else
            response=$(gh api graphql -f owner="$OWNER" -f repo="$REPO" -F prNumber="$pr_number" -f query='
                query($owner: String!, $repo: String!, $prNumber: Int!) {
                    repository(owner: $owner, name: $repo) {
                        pullRequest(number: $prNumber) {
                            reviewThreads(first: 100) {
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                                nodes {
                                    id
                                    isResolved
                                    comments(first: 1) {
                                        nodes {
                                            databaseId
                                            author { login }
                                            body
                                            path
                                            line
                                            createdAt
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            ')
        fi

        # Extract pagination info
        has_next_page=$(echo "$response" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
        end_cursor=$(echo "$response" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')

        # Merge threads
        local page_threads
        page_threads=$(echo "$response" | jq -r '.data.repository.pullRequest.reviewThreads.nodes')
        all_threads=$(echo "$all_threads" | jq --argjson new "$page_threads" '. + $new')
    done

    # Return in original format
    echo "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":$all_threads}}}}}"
}

# Reply to a review comment (REST API)
reply_to_comment() {
    local pr_number="$1"
    local comment_id="$2"
    local message="$3"

    echo -e "${BLUE}Replying to comment: $comment_id${NC}"

    gh api "repos/$OWNER/$REPO/pulls/$pr_number/comments/$comment_id/replies" \
        -f body="$message" || {
        echo -e "${RED}❌ Failed to reply to comment $comment_id${NC}"
        return 1
    }

    echo -e "${GREEN}✅ Reply posted successfully${NC}"
}

# Resolve a specific thread (GraphQL)
resolve_thread() {
    local thread_id="$1"

    echo -e "${BLUE}Resolving thread: $thread_id${NC}"

    gh api graphql -f threadId="$thread_id" -f query='
        mutation($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
                thread {
                    id
                    isResolved
                    resolvedBy { login }
                }
            }
        }
    ' || {
        echo -e "${RED}❌ Failed to resolve thread $thread_id${NC}"
        return 1
    }

    echo -e "${GREEN}✅ Thread resolved successfully${NC}"
}

# List threads command
cmd_list() {
    local pr_number="$1"
    local unresolved_only="${2:-}"

    echo -e "${BLUE}Fetching review threads for PR #$pr_number...${NC}\n"

    local response
    response=$(fetch_threads "$pr_number")

    # Parse with jq
    local threads
    threads=$(echo "$response" | jq -r '.data.repository.pullRequest.reviewThreads.nodes')

    local total_count
    total_count=$(echo "$threads" | jq 'length')

    local resolved_count=0
    local unresolved_count=0
    local greptile_count=0

    while IFS=$'\t' read -r thread_id is_resolved author body_b64 path line comment_id; do
        # Values already extracted by jq (body is base64-encoded to handle newlines)
        local body
        body=$(echo "$body_b64" | base64 -d 2>/dev/null || echo "")

        # Count
        if [ "$is_resolved" = "true" ]; then
            resolved_count=$((resolved_count + 1))
        else
            unresolved_count=$((unresolved_count + 1))
        fi

        if [[ "$author" == "greptile-apps"* ]]; then
            greptile_count=$((greptile_count + 1))
        fi

        # Filter if needed
        if [ "$unresolved_only" = "--unresolved" ] && [ "$is_resolved" = "true" ]; then
            continue
        fi

        # Display
        if [ "$is_resolved" = "true" ]; then
            echo -e "${GREEN}✓ RESOLVED${NC} | $path:$line"
        else
            echo -e "${RED}✗ UNRESOLVED${NC} | $path:$line"
        fi

        echo -e "  ${BLUE}Thread ID:${NC} $thread_id"
        echo -e "  ${BLUE}Comment ID:${NC} $comment_id"
        echo -e "  ${BLUE}Author:${NC} $author"

        # Extract title from body (first line)
        local title
        title=$(echo "$body" | head -n 1 | sed 's/\*\*//g')
        echo -e "  ${BLUE}Issue:${NC} $title"
        echo ""
    done < <(echo "$threads" | jq -r '.[] | [.id, .isResolved, (.comments.nodes[0].author.login // "unknown"), ((.comments.nodes[0].body // "") | @base64), (.comments.nodes[0].path // "unknown"), (.comments.nodes[0].line // "?"), (.comments.nodes[0].databaseId // "?")] | join("\t")')

    echo -e "\n${YELLOW}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}Statistics for PR #$pr_number:${NC}"
    echo -e "  Total threads: $total_count"
    echo -e "  ${GREEN}Resolved: $resolved_count${NC}"
    echo -e "  ${RED}Unresolved: $unresolved_count${NC}"
    echo -e "  Greptile threads: $greptile_count"
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
}

# Reply to comment command
cmd_reply() {
    local pr_number="$1"
    local comment_id="$2"
    local message="${3:-}"

    if [ -z "$comment_id" ]; then
        echo -e "${RED}Error: Comment ID required${NC}"
        usage
    fi

    if [ -z "$message" ]; then
        echo -e "${RED}Error: Message required${NC}"
        usage
    fi

    echo -e "${BLUE}Replying to comment for PR #$pr_number...${NC}\n"

    reply_to_comment "$pr_number" "$comment_id" "$message"
}

# Resolve specific thread
cmd_resolve() {
    local pr_number="$1"
    local thread_id="$2"

    if [ -z "$thread_id" ]; then
        echo -e "${RED}Error: Thread ID required${NC}"
        usage
    fi

    echo -e "${BLUE}Resolving thread for PR #$pr_number...${NC}\n"

    resolve_thread "$thread_id"
}

# Reply and resolve in one step
cmd_reply_and_resolve() {
    local pr_number="$1"
    local comment_id="$2"
    local thread_id="$3"
    local message="${4:-}"

    if [ -z "$comment_id" ] || [ -z "$thread_id" ]; then
        echo -e "${RED}Error: Both comment ID and thread ID required${NC}"
        usage
    fi

    if [ -z "$message" ]; then
        echo -e "${RED}Error: Message required${NC}"
        usage
    fi

    echo -e "${BLUE}Replying and resolving for PR #$pr_number...${NC}\n"

    # Step 1: Reply
    reply_to_comment "$pr_number" "$comment_id" "$message" || return 1

    # Step 2: Resolve
    resolve_thread "$thread_id" || return 1

    echo -e "\n${GREEN}✓ Successfully replied and resolved!${NC}"
}

# Resolve all unresolved Greptile threads
cmd_resolve_all() {
    local pr_number="$1"

    echo -e "${YELLOW}⚠️  WARNING: This will resolve ALL unresolved Greptile threads for PR #$pr_number${NC}"
    echo -e "${YELLOW}Make sure you have fixed all issues AND replied to each thread before running this!${NC}\n"

    read -p "Continue? (y/n) " -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        exit 0
    fi

    echo -e "\n${BLUE}Fetching unresolved Greptile threads...${NC}\n"

    local response
    response=$(fetch_threads "$pr_number")

    local threads
    threads=$(echo "$response" | jq -r '.data.repository.pullRequest.reviewThreads.nodes')

    local resolved_count=0
    local failed_count=0

    while IFS= read -r thread; do
        local thread_id
        thread_id=$(echo "$thread" | jq -r '.id')

        local is_resolved
        is_resolved=$(echo "$thread" | jq -r '.isResolved')

        local author
        author=$(echo "$thread" | jq -r '.comments.nodes[0].author.login // "unknown"')

        # Skip if already resolved
        if [ "$is_resolved" = "true" ]; then
            continue
        fi

        # Skip if not Greptile
        if [[ "$author" != "greptile-apps"* ]]; then
            continue
        fi

        # Resolve
        echo -e "${BLUE}Resolving thread $thread_id...${NC}"
        if resolve_thread "$thread_id" > /dev/null 2>&1; then
            resolved_count=$((resolved_count + 1))
            echo -e "${GREEN}✓ Resolved${NC}"
        else
            failed_count=$((failed_count + 1))
            echo -e "${RED}✗ Failed${NC}"
        fi

        # Small delay to avoid rate limiting
        sleep 0.5
    done < <(echo "$threads" | jq -r '.[] | @json')

    echo -e "\n${YELLOW}═══════════════════════════════════════${NC}"
    echo -e "${GREEN}✓ Resolved: $resolved_count threads${NC}"
    if [ "$failed_count" -gt 0 ]; then
        echo -e "${RED}✗ Failed: $failed_count threads${NC}"
    fi
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
}

# Stats command
cmd_stats() {
    local pr_number="$1"

    echo -e "${BLUE}Fetching statistics for PR #$pr_number...${NC}\n"

    local response
    response=$(fetch_threads "$pr_number")

    local threads
    threads=$(echo "$response" | jq -r '.data.repository.pullRequest.reviewThreads.nodes')

    local total_count
    total_count=$(echo "$threads" | jq 'length')

    local resolved_count
    resolved_count=$(echo "$threads" | jq '[.[] | select(.isResolved == true)] | length')

    local unresolved_count
    unresolved_count=$(echo "$threads" | jq '[.[] | select(.isResolved == false)] | length')

    local greptile_count
    greptile_count=$(echo "$threads" | jq '[.[] | select(.comments.nodes[0].author.login | startswith("greptile-apps"))] | length')

    local greptile_unresolved
    greptile_unresolved=$(echo "$threads" | jq '[.[] | select(.isResolved == false and (.comments.nodes[0].author.login | startswith("greptile-apps")))] | length')

    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}PR #$pr_number Review Thread Statistics:${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
    echo -e "Total threads: $total_count"
    echo -e "${GREEN}Resolved: $resolved_count${NC}"
    echo -e "${RED}Unresolved: $unresolved_count${NC}"
    echo -e ""
    echo -e "Greptile threads: $greptile_count"
    echo -e "${RED}Greptile unresolved: $greptile_unresolved${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"

    if [ "$greptile_unresolved" -eq 0 ]; then
        echo -e "\n${GREEN}✓ All Greptile threads resolved!${NC}"
    else
        echo -e "\n${YELLOW}⚠️  $greptile_unresolved Greptile thread(s) still unresolved${NC}"
        echo -e "Run: $(basename "$0") list $pr_number --unresolved"
    fi
}

# Main command dispatcher
main() {
    # Check for jq dependency
    check_jq

    if [ $# -lt 2 ]; then
        usage
    fi

    local command="$1"
    local pr_number="$2"
    shift 2

    case "$command" in
        list)
            cmd_list "$pr_number" "$@"
            ;;
        reply)
            cmd_reply "$pr_number" "$@"
            ;;
        resolve)
            cmd_resolve "$pr_number" "$@"
            ;;
        reply-and-resolve)
            cmd_reply_and_resolve "$pr_number" "$@"
            ;;
        resolve-all)
            cmd_resolve_all "$pr_number"
            ;;
        stats)
            cmd_stats "$pr_number"
            ;;
        *)
            echo -e "${RED}Unknown command: $command${NC}\n"
            usage
            ;;
    esac
}

main "$@"
