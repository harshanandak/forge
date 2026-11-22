# Vercel Board on X: impressions (read 2026-11-21)

Usable posts kept: 52 (more than 10). Signed in as the owner's account, read only. X returned at most 5 posts per search page and replies under posts did not render, so this is a thin slice of a 510K-view announcement (216 replies, 364 reposts, 2.7K likes, 3.5K bookmarks at read time). Counts below are as shown: reposts / likes / replies.

Vercel affiliation, only where bio or post says so: @vercel (official account), @rauchg (X label "@vercel CEO"), @cramforce (bio: "@Vercel CTO"), @ctatedev (bio: "@Vercel Labs"), @montonenico (bio: "@v0 by @vercel"). Everyone else: affiliation not confirmed.

## 1. What this means for us

Each bullet marks what people said versus my reading.

1. Vercel itself says Board has no UI of its own and that people should bring theirs. Said: Rauch "no heavyweight or opinionated UI. It's infra not product" (2123468825538789380); Tate "Now you can BYOUI" (2123585277536944319). Reading: the human-facing layer is an open gap by design. It is also not defensible alone, because Vercel tells everyone to generate it.
2. The strongest match to our direction is Malte Ubl's own factory. Said: "A needs-you board is used for agents to ask questions to the factory owners" and approval nudges "are tracked on the board to prevent over-nudging" (2123442758606352420). Reading: questions that need a human, and not nagging the same person twice, are real needs at Vercel.
3. Vercel's stance on noise is the same as ours. Said: "Update the humans when something important happened but don't spam them 24/7" (2123470032223277340). An outside reply offers a rule: reaches a human only when "the agent needs a decision, or it caused a side effect outside its sandbox" (xmnevfel, 2123474285310407031). Reading: the escalation threshold is the product, not the channel.
4. An outside user already runs our phone scenario by hand. Said: Justin Perea connected "MacBook, PC, and phone" over Tailscale and has "a channel where each agent puts things I need to decide in one place" (2123879151061074274). Reading: a decision inbox that works on a phone has demand today and no first-party answer.
5. The human-as-bottleneck problem is stated by a builder. Said: AaronCQL "I have become the bottleneck"; his tool alerts you "when something genuinely needs your attention" and does safe decisions "provisionally first" (2123687476548293067). Reading: supports question queues plus provisional answers. Single user, so treat as one data point.
6. Skeptics say the value is choosing, not drawing. Said: "ui is free to generate, not to decide" (arthurhumeau_, 2123474723300409373); keep approval "painfully human" (davzer_, 2123483144619979032); Rick Blalock first disliked it, preferring "something that surfaces decisions and leaves me out" (2123244827865469090). Reading: lead with what needs me and a short summary, not a chat feed.
7. Teams and permissions are the open pain. Said: a security thread on the docs says new boards start wide open, "a profile changes the name the board shows and never the permissions", and synced Slack/GitHub/Linear channels lose board grants (DYoung_AI, 2123403931107655836; second-hand reading of Vercel docs). Users ask who is shown as author when an agent-built UI posts (dnzxlyfe), whether agents see every thread (BasMondragon), and ask for revocable per-agent identity (BLKHAgent). Reading: who may answer or approve, and attributing an answer to a human, is unsolved.
8. The "why not X" questions mostly went unanswered in what I could read. Asked: versus Beads (rsnodgrass), versus Linear ("Why can't you just ditch Linear", wMrSaints), moving off Slack (ab_hanifi). Vercel's only answer found is Malte's "headless Slack/Linear for agents" post. Reading: Board is positioned as agent plumbing next to human tools, and our "human oversight" angle is the part left to others.
9. The primitive gets cloned within two days. Said: "rebuilt vercel/board with brickkit" (chandra_7852), "one-shotted vercel/board with Alchemy Domain" (samgoodwin89), tick.md, APE. Reading: do not build the shared message store as the moat.
10. Not found in anything I read: catch-up summaries from Vercel, a native phone app or push notifications from Vercel, and any answer on pricing beyond "free while experimental". One poster asks for a commit-SHA check on "verified" task state (AIGrowWorks). Absence is rung 1 only: a few searches, 5 posts per page, replies not rendered.

## 2a. How Vercel people describe it

- @vercel (official), 2026-11-19, https://x.com/vercel/status/2123234769236619673 (364 / 2.7K / 216): "a secure message board for people & agents. Give agents a shared place for tasks. Build swarms and software factories. Set permissions for humans and agents. Board is experimental."
- @rauchg (Guillermo Rauch, Vercel CEO), 2026-11-19, https://x.com/rauchg/status/2123237505810178434 (95 / 1.9K / 153): "We built a message board infrastructure primitive. You can think of it as 'headless Slack' (or remember IRC?) for agents." Also: "software factories, self-optimizing systems, and scientific research, where the human prompting is just the seed."
- @rauchg, 2026-11-19, https://x.com/rauchg/status/2123468825538789380 (25 / 404 / 95): "I've seen internal factories at Vercel built on Board that are just TUIs. Or mostly managed via a Slack agent, and you just focus on the outcomes and giving feedback to the agents." Also: "The board is like the Redux state manager of your agents."
- @cramforce (Malte Ubl, Vercel CTO), 2026-11-19, https://x.com/cramforce/status/2123235014435631551 (12 / 403 / 40): "Vercel Board is harness agnostic... Claude, codex, pi, opencode, eve, fx, mastra, and langchain can collaborate as if they were a single harness."
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123442758606352420 (27 / 419 / 38): "Agents running on Vercel Sandboxes use a comms channel to communicate and give each other tasks. E.g. there is a dedicated agent that makes sure PRs stay green over time." Also: "The agents just love using the board and the emergent behavior is delightful."
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123442758606352420 (same post, second factory): "All agents log their decisions to a central board for knowledge sharing... The factory has a daily run where it inspects the logs and traces to improve its own behavior."
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123470032223277340 (7 / 99 / 13): "Do I need headless Slack for Agents? Do I need headless Linear for Agents? The answer is: Yes. Why? Because the current tools are for humans."
- @cramforce, 2026-11-20, https://x.com/cramforce/status/2123926740842213768 (5 / 118 / 16): "Just merged per-harness tool mappings to the Vercel Board skill." (This is what is coming next: transfer of each harness's own comms tools to Board commands.)
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123462315576291544 (0 / 11 / 2): "Board works great from cloudflare workers. It's just a REST API"
- @ctatedev (Chris Tate, bio "@Vercel Labs"), 2026-11-20, https://x.com/ctatedev/status/2123585277536944319 (93 / 1.7K / 73): "Vercel Board is a headless message board for humans and agents. Headless means *any* UI, not 'no UI'... The threads, team, agents stay shared."
- @montonenico (monto, bio "@v0 by @vercel"), 2026-11-19, https://x.com/montonenico/status/2123237334892306538 (1 / 70 / 3): "Launch a hundred agent swarm to achieve a goal, all on the same secure message board, try the template here."
- @montonenico, 2026-11-19, https://x.com/montonenico/status/2123236184994574724 (3 / 83 / 8): "connect any harness, agent, app to the same board and let agents collaborate. vercel board let me know if you have any feedback"
- @montonenico, 2026-11-20, https://x.com/montonenico/status/2123855988315058498 (0 / 10 / 3): "I want to see vercel board UIs"
- @montonenico, 2026-11-20, https://x.com/montonenico/status/2123599874788933965 (0 / 28 / 1): "woah, ship your own vercel board ui"
- Second-hand, affiliation not confirmed, @poseidanai, 2026-11-20, https://x.com/poseidanai/status/2123847389018501408 (0 / 0 / 0): "Vercel says v0's factory merges 50%+ of its PRs on it. Experimental, tbh we will see". Not verified against a Vercel source.

## 2b. Praise from outside users

- @JustinPerea, 2026-11-20, https://x.com/JustinPerea/status/2123879151061074274 (1 / 3 / 0): "Spent all day testing out @vercel Board. It's really nice. I gave each project its own color. All of the sessions can communicate to each other."
- @giuseppecrj, 2026-11-21, https://x.com/giuseppecrj/status/2124008778307969488 (0 / 0 / 0): "the elegant sdk/cli coding structure of the new @vercel board is just chef's kiss."
- @coreyepstein, 2026-11-19, https://x.com/coreyepstein/status/2123263951815455085 (4 / 283 / 14): "Can't believe we didn't think of this"
- @wojkuli, 2026-11-19, https://x.com/wojkuli/status/2123400512594718847 (6 / 210 / 12): "Huge. This + opus 5.5 + @boatdotdev + @e2e and you can build anything with one prompt"
- @gregeland, 2026-11-19, https://x.com/gregeland/status/2123419593360441373 (0 / 0 / 1): "I was cobbling several things together to try and solve for this, and I think this just one shot it."
- @giuseppegurgone, 2026-11-19, https://x.com/giuseppegurgone/status/2123481527350702407 (0 / 0 / 1): "i think these headless/sdk-centric solutions are going to win because they meet people where they are, lower friction, not all-in buy-in, inversion of control"
- @giuseppegurgone, 2026-11-19, https://x.com/giuseppegurgone/status/2123483559122116832 (0 / 0 / 0): "the idea of inverting/extracting them to a board and have a shared space where threads and status is managed is pretty sweet (and more powerful)"
- @luosky0314, 2026-11-20, https://x.com/luosky0314/status/2123562809787302011 (12 / 137 / 7): "It isn't a 'company brain,' and it isn't a group chat for agents. It's a bulletin board."
- @RayPendragon1, 2026-11-19, https://x.com/RayPendragon1/status/2123513415276671105 (0 / 0 / 0): "love that 'headless' app think... we need more focus on apps for agents"
- @_thisisnithin, 2026-11-20, https://x.com/_thisisnithin/status/2123778093546623111 (0 / 0 / 0): "I can imagine using @vercel board to distribute company compute and token usage."
- @nischay_v, 2026-11-19, https://x.com/nischay_v/status/2123309155423305963 (0 / 0 / 0): "Can't wait to use this in our subagent stack!"
- @michaltakac, 2026-11-20, https://x.com/michaltakac/status/2123567988901285937 (0 / 0 / 0): "Putting this to work @TheDimensionLab for fork-and-flush autoresearch of building multiple physics solvers"

## 2c. Criticism, doubts, jokes, comparisons

- @rblalock (Rick Blalock), 2026-11-19, https://x.com/rblalock/status/2123244827865469090 (0 / 3 / 2): "My knee jerk reaction was: I don't like it...I prefer something that surfaces decisions and leaves me out of all the sillyness...but... the 'for agents' part seems really useful." Follow-up 2026-11-20 (https://x.com/rblalock/status/2123924794915917921): "no verdict yet."
- @rsnodgrass (Ryan Snodgrass), 2026-11-20, https://x.com/rsnodgrass/status/2123529857527427329 (0 / 0 / 0): "How is Vercel Board better than Beads? I'm not in Vercel ecosystem right now, heavy beads user and wondering if I'm missing something." No reply seen.
- @wMrSaints (Ian L.), 2026-11-20, https://x.com/wMrSaints/status/2123676341224837561 (0 / 0 / 0): "'We're syncing Linear tickets into the board as tasks' Why can't you just ditch Linear, and send the tickets straight to the board?"
- @turanzeyn, 2026-11-20, https://x.com/turanzeyn/status/2123488583776628832 (0 / 0 / 0): "If the interface is free, what are we really paying for..."
- @arthurhumeau_, 2026-11-19, https://x.com/arthurhumeau_/status/2123474723300409373 (0 / 0 / 0): "ui is free to generate, not to decide. the security team still needs someone to choose which three numbers sit on top"
- @davzer_, 2026-11-19, https://x.com/davzer_/status/2123483144619979032 (0 / 0 / 0): "the approval step is the one part I'd keep painfully human though: agents opening fix PRs at scale is also how one bad 'fix' ships everywhere at once"
- @nathan_ricks6, 2026-11-19, https://x.com/nathan_ricks6/status/2123287965682241993 (0 / 0 / 0): "Message boards were also at the heart of the Hugging Face attack hopefully Vercel includes some good monitoring features"
- @naman_k, 2026-11-20, https://x.com/naman_k/status/2123556088985645298 (0 / 0 / 0): "who the f is leading product at v" (complaint, no detail in the post).
- @sonikudzu, 2026-11-19, https://x.com/sonikudzu/status/2123439787365290397 (0 / 0 / 0): "what happens to data in Board?"
- @DYoung_AI, 2026-11-19, https://x.com/DYoung_AI/status/2123403931107655836 (0 / 6 / 4): "Official docs are blunter about the default: a new board is wide open until you change it." The author says he had not created a board on a live team (second-hand reading of the docs).
- @montonenico, 2026-11-21, https://x.com/montonenico/status/2124192890230575412 (0 / 0 / 0): "This is just a vercel board" (used as a generic phrase for a shared agent board).
- @sangwan_nit and @michaltakac asked @grok how it compares to a Jack Dorsey product and to @papercliping (2123351341414359502, 2123280168680866233). No human answers seen.
- @newzealandhodl, 2026-11-19, https://x.com/newzealandhodl/status/2123264797508853946 (0 / 0 / 0): "What's your thoughts on how this compares to @buzzdotxyz @rauchg ?"
- @KissonL, 2026-11-20, https://x.com/KissonL/status/2123807365338149099 (0 / 0 / 3): "the best coordination benchmark I read this week found the messaging barely helps yet." (Second-hand claim, not checked.)
- @sudoaptaj, 2026-11-21, https://x.com/sudoaptaj/status/2124198863804215366: "11 devs building the factory, meanwhile I'm the factory and the support inbox" (unrelated to Board, a search false hit; not counted in the 52).

## 2d. Humans in the loop

- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123442758606352420: "A needs-you board is used for agents to ask questions to the factory owners." and "Nudging devs for approvals is a big part of getting things merged, so those are tracked on the board to prevent over-nudging."
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123442758606352420: "Inbound messages (comments on GH, Linear, replies to nudges) from devs are put on the board and processed by a dedicated agent to determine future actions."
- @rauchg, 2026-11-19, https://x.com/rauchg/status/2123468825538789380: "Or mostly managed via a Slack agent, and you just focus on the outcomes and giving feedback to the agents."
- @JustinPerea, 2026-11-20, https://x.com/JustinPerea/status/2123879151061074274: "I have a channel where each agent puts things I need to decide in one place and I can just respond there." He reaches it from a phone via Tailscale.
- @AaronCQL, 2026-11-20, https://x.com/AaronCQL/status/2123687476548293067 (1 / 6 / 4): "anything that requires your decision (but is otherwise safe to do) will just be done provisionally first, but it's all tracked and you can always change it later on."
- @xmnevfel (Mustafa Nevfel), 2026-11-19, https://x.com/xmnevfel/status/2123474285310407031: "A workable line for what reaches a human: the agent needs a decision, or it caused a side effect outside its sandbox. Everything else stays in the trace."
- @i_Am_Snow_Flake, 2026-11-20, https://x.com/i_Am_Snow_Flake/status/2123785309280485857: "the hard part of a multi-agent setup isn't the agents. it's remembering who already got nudged for a PR approval."
- @Qihang5688, 2026-11-21, https://x.com/Qihang5688/status/2124095175329042523 (0 / 1 / 0): in Chinese, "this board is still too fine-grained for humans" (my translation); says it is first of all a workbench for agents, with only important state synced to Slack, GitHub, Linear.
- @montonenico, 2026-11-20, https://x.com/montonenico/status/2123855988315058498: "I want to see vercel board UIs" (a Vercel person asking for human-facing UIs).
- @deviorobert (Robert DeVore), 2026-11-21, https://x.com/deviorobert/status/2124186747382779955: "Introducing Chessboard: a custom UI for Vercel Board. Watch an agent claim work, move into review, and deliver a result."
- @ctatedev, 2026-11-20, https://x.com/ctatedev/status/2123585277536944319: "Everyone visualizes work differently: chat, boards, a terminal."
- @foda, 2026-11-21, https://x.com/foda/status/2124176092864950644 (0 / 1 / 0): "now if they can just refer projects to projects, and organizing those projects across a vercel/board type thing"

## 2e. Teams, permissions, noise

- @DYoung_AI, 2026-11-19, https://x.com/DYoung_AI/status/2123403931107655836: "Every person on your team can do everything, limited by their team role." "A coding agent you run acts with your access." "a private channel stays private only on the board." (All quoted from his reading of the official docs.)
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123470032223277340: "This is why Vercel Board is all about syncing major state into Slack and Linear."
- @BasMondragon, 2026-11-20, https://x.com/BasMondragon/status/2123621097216090135 (0 / 3 / 0): "do the agents see every thread on the board or only the ones they get tagged in?"
- @ethanflow_lab, 2026-11-21, https://x.com/ethanflow_lab/status/2124095953863127223: "I ended up leaving it to each owner, per group: the AI hears everything, only when a human speaks, or only when it's called. One default never fit everyone."
- @dnzxlyfe (Jay Song), 2026-11-20, https://x.com/dnzxlyfe/status/2123589959420649934: "If my agent builds my Board UI and I post from it, does the thread show me or the agent as the author?"
- @necklace_btc, 2026-11-20, https://x.com/necklace_btc/status/2123620101270470977 (0 / 1 / 1): Board already supports "assigning an identity to an Agent... granting permissions by project/environment/channel, and recording the actor for each event." Reply from @BLKHAgent: "Stable per-instance identity that can be revoked on its own is the part people skip."
- @FOMAnews, 2026-11-19, https://x.com/FOMAnews/status/2123364417584714039: "each person brings their own agents... the room is shared, the agent isn't. Your agent keeps your permissions, your memory and your bill." (Third-party framing.)
- @cramforce, 2026-11-19, https://x.com/cramforce/status/2123442758606352420: the vulnerability factory has "the board data is mined for a gamification dashboard", so people compete on it.
- @gsemetfr, 2026-11-20, https://x.com/gsemetfr/status/2123560745400926460: "I added a WebUI board to Chantier and this requires to keep several 'states' across several agents."

## 2f. Requests

- @develogue, 2026-11-19, https://x.com/develogue/status/2123466147593159148: "So, we can self-host Board frontend, backend and APIs on AWS, for example? What's the pricing/licensing model?"
- @ab_hanifi, 2026-11-20, https://x.com/ab_hanifi/status/2123825277134590323: "How easy is it to move off Slack and onto Board for teams?"
- @AIGrowWorks, 2026-11-20, https://x.com/AIGrowWorks/status/2123676042061898062: "Do you tie the Board task's verified state to a commit SHA? A PR can stay the same while the code it contains changes."
- @nathan_ricks6: "hopefully Vercel includes some good monitoring features" (2123287965682241993).
- @montonenico: "I want to see vercel board UIs" (2123855988315058498).
- @GianniDalerta, 2026-11-20, https://x.com/GianniDalerta/status/2123812973118468290: "Leases and scheduled follow-ups are what I'd steal. What broke first when you outgrew a markdown file?" (A competitor builder asking Vercel; also lists tick.md, a markdown board in git with MCP.)
- @voidisomorphism, 2026-11-20, https://x.com/voidisomorphism/status/2123582511347609614: asks Malte to talk, has built agent-swarm "as oss mit for almost a year."
- Clones and adjacent tools posted in the same days (evidence the primitive is easy to copy): @chandra_7852 "rebuilt vercel/board with brickkit" (2124189081639035085); @samgoodwin89 "I one-shotted vercel/board with Alchemy Domain lol" (22h before the read, seen quoted in a search page); @AaronCQL APE (2123687476548293067); @backnotprop 2026-09-15 "Gave my agents a message board & direct chat. headless slack basically on durable objects" (https://x.com/backnotprop/status/2099671381722210708, before Board); @raunakdoesdev 2026-10-05 headless Slack client for agents (https://x.com/raunakdoesdev/status/2106866286722752828).

## 3. Limits

What I ran (X search unless noted; each page showed at most 5 posts, scrolling did not load more, and replies under single posts did not render):
1. "Vercel Board" latest: 5
2. "Vercel Board" top: 5
3. from:rauchg board since:2026-11-18: 2
4. from:cramforce board since:2026-11-18: 5
5. from:vercel board since:2026-11-18: 1
6. vercel board human OR approval OR approve OR notify OR phone: failed, X dropped "vercel board" and returned 5 unrelated posts
7. "vercel board" (human OR approval OR slack OR linear): 5
8. "vercel board" (beads OR jira OR github OR discord): 5 (same as 7)
9. vercel board beads: 1
10. vercel board linear: 5
11. "headless slack" agents top: 4
12. vercel/board top: 5
13. vercel board ui: 5
14. "vercel board" factory: 5
15. "vercel board" (just OR why OR another OR lock-in OR meh): 8
16. quotes page of the announcement: 5
17. conversation_id of the announcement, top: 11
18. conversation_id of the announcement, latest: 11
19. conversation_id of Rauch's first post: 11
20. conversation_id of Malte's factories post: 5
21. conversation_id of Chris Tate's post: 5
22. conversation_id of Rauch's UI post: 5
23. conversation_id of Malte's headless Slack/Linear post: 5
24. "vercel board" min_faves:15 top: 5
25. from:cramforce since:2026-11-19 -board: 8 (not about Board, nothing kept)
26. from:cramforce slack since:2026-11-19: 1
27. vercel board permissions team: 5
28. vercel board mobile OR notifications OR inbox: failed, 14 unrelated posts
29. "vercel board" notifications: 1 (empty text, nothing kept)
30. "vercel board" security: 5
31. "vercel board" dashboard: 2

Also loaded: 8 single post pages (full text of long posts) and 3 public profiles (montonenico, ctatedev, cramforce) for bios. Total page loads about 62, slightly over the 60 budget. Time was inside 35 minutes.

Could not load or did not get:
- Replies under the announcement and under single posts did not render on status pages; I used conversation_id searches instead, which returned 5 to 11 posts each, mostly short and some spam-like.
- OR in search queries is unreliable on X (two queries returned junk). Results look ranked or sampled, so a missing criticism does not mean none exists.
- A first try with a scrolling script hung the tab; I closed it and used a fresh one.
- Like and repost counts are as displayed at read time; the first search showed the announcement at 2.7K likes, in line with the post page.

Inferred, not read: the scope of the "factory" claims (v0 merging 50%+ PRs is a third-party summary, not checked against Vercel). Malte's "needs-you board" is quoted, but I did not see its UI (a screenshot was attached to the post, not viewed). The 5-vs-52 gap between what X shows and the real conversation is large, so bullets 8 and 10 are weak absence claims.

Not named in your query list and not run: from:rauchg "board" beyond the 2 posts shown; people posts about Vercel Board in other languages beyond the Chinese ones shown; the Vercel blog, docs and GitHub (not allowed for this task).

COVERED 29 OF 31
