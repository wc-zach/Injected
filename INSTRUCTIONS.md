Brief: injected credential form (MV3 extension)
Setup & scope. In one hour, build a loadable, unpacked Manifest V3 extension for Chrome. Use
vanilla JS or a framework of your choice; keep dependencies minimal and justify any you add.
Use of AI is encouraged. Lean on whichever coding assistant you like, with the assistant handling
most of the implementation. We are not grading boilerplate; we care about the decisions you make
and correct. Be ready to explain and defend everything you submit.
Deliverable. The extension (repo), plus short notes on your design decisions, trust boundaries, and
what you would change for production. We care most about these notes and your explanation of
them.
Credential-store assumption. Treat chrome.storage.local as an asynchronous stand-in for a
credential API, and use synthetic credentials only. You do not need to build a server,
authentication, encryption, or key management. This mock is not a production vault: however, you are
still responsible for where plaintext travels within the extension.
Functional requirements
1. On any top-level http/https page, a content script injects an Open button, fixed at the top right and
overlaying page content.
2. Clicking Open surfaces an iframe hosting a small form: username, password, and Submit.
3. Submitting saves the credential pair to the credential store stand-in.
4. Once saving completes, reloading or navigating to another path on the same origin and clicking
Open shows that pair pre-filled. A different origin starts blank. The saved pair survives a
browser restart.
Before you architect, consider:
• Treat the host page as untrusted. It is not your code and may be malicious.
• Minimize plaintext exposure. Explain every execution context that receives or can read the
credentials.
• Explain how a credential lookup is bound to the site the user is visiting, and what prevents a
hostile page from requesting another origin’s pair.
We are looking for sound reasoning about isolation, data flow, and trust boundaries, and
extension architecture used well—not feature count or storage internals.