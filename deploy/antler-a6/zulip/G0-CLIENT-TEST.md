# Gate G0 — AntlerForge Zulip stock-client test

Organization URL: `https://zulip.antlerforge.com`

Use the ordinary Zulip app on each device. Do not use a browser substitute.

For Mac, iPhone and iPad separately:

1. Add the organization URL above.
2. Complete the Cloudflare Access email login if shown, then sign in to Zulip.
3. Open the `g0-test` channel and topic `stock-client`.
4. Send `DEVICE pass 1`, replacing DEVICE with Mac, iPhone or iPad.
5. Confirm the other test message arrives without refreshing.
6. Open the attached `g0-test.txt` file.
7. Leave the app open for 20 minutes and confirm a new message arrives live.
8. On iPhone and iPad, allow notifications and confirm a mention notification arrives within one minute.
9. Sign out and back in once so the Access session is refreshed, then repeat step 4 with `pass 2`.

Record PASS or FAIL for every line in `g0-results.md`. Any failure stops the build;
do not add an Access bypass or change ingress.
