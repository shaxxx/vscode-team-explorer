# Create a Personal Access Token

[Back to the install guide](README.md)

Team Explorer (TFVC) authenticates by running `tf.exe` with a Personal Access Token (PAT) instead
of an interactive sign-in. You create the token once in Azure DevOps, then save it where the
`tfp` wrapper can read it.

## Create the token

1. In your browser, go to your Azure DevOps organisation (for example
   `https://dev.azure.com/your-org/`) and open **User settings** (top right) -> **Personal access
   tokens** -> **New Token**.
2. **Name**: anything that helps you recognise it later, for example `tf-vscode`.
3. **Organization**: the organisation that hosts your TFVC project.
4. **Expiration**: pick the shortest expiry that is practical for you. A token with this scope is
   worth treating like a password — see Security notes below.
5. **Scopes**: select **Full access**.

   `tf.exe` does not authenticate through Azure DevOps' REST API — it talks to older SOAP
   endpoints (`LocationService.asmx`, `repository.asmx`). A narrower **Code (Read & Write)**
   token is accepted by the REST API but is rejected by those endpoints, and `tf` reports error
   `TF30063` ("not authorized"). **Full access** is the scope that actually works with `tf.exe`.
6. Select **Create**, then copy the token. Azure DevOps shows it only once.

## Save it

The `tfp` wrapper reads the token from a plain text file: the token as the only content of the
first line, encoded as UTF-8, with **no byte-order mark (BOM)**. A BOM would be read as part of
the token itself, and every `tf` command would then fail with an opaque authentication error.

If this is the first time through this guide, the extension is not installed yet — that is
[step 3](README.md) — so save it by hand for now, below. Once the extension is installed, the
easiest way to save a token, including when you renew it later, is its own command; that is
described after.

### Save it by hand

Whatever way you do it, never type the token itself as a command-line argument — text typed on a
command line can end up in your shell history. First create the folder:

- **Windows (PowerShell)**:
  ```powershell
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.tfs" | Out-Null
  ```
- **Linux (bash)**:
  ```bash
  mkdir -p ~/.tfs && chmod 700 ~/.tfs
  ```

Then put the token in the file, without it ever appearing as a typed argument:

- **Simplest, on any platform**: open the file — `%USERPROFILE%\.tfs\pat.txt` on Windows,
  `~/.tfs/pat.txt` on Linux — in a plain text editor such as Notepad or `nano`. Neither file exists
  yet the first time through this page: on Windows, `notepad "$env:USERPROFILE\.tfs\pat.txt"`
  after creating the folder above offers to create it; on Linux, `nano ~/.tfs/pat.txt` creates it
  as soon as you save. Paste the token as the only line, and save. In Notepad's Save dialog, set
  **Encoding** to **UTF-8**, not "UTF-8 with BOM".
- **Linux, from a terminal**, reading the token without echoing it to the screen or a history
  file:
  ```bash
  read -rs t && printf '%s\n' "$t" > ~/.tfs/pat.txt && unset t
  chmod 600 ~/.tfs/pat.txt
  ```
- **Windows, from PowerShell**, reading the token as a masked prompt instead of a typed argument
  (if this feels unfamiliar, use the editor method above instead):
  ```powershell
  $sec = Read-Host -AsSecureString "Paste your token"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) |
    Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\.tfs\pat.txt"
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable sec, bstr
  ```

### Save it with the extension (once it is installed, or when renewing)

Once [the extension is installed](vscode.md), the easiest way to save the token — including the
next time you renew it — is the command **Team Explorer: Set Personal Access Token**
(`teamExplorer.setPat`) from the Command Palette:

1. Run the command and paste the token into the input box (it is masked as you type).
2. The extension rejects a value that contains a space or a line break — the wrapper reads only
   the first line of the file, so anything else could never authenticate.
3. It saves the token in VS Code's own secret storage, and writes it to the same file the wrapper
   reads: `~/.tfs/pat.txt` on Linux, `%USERPROFILE%\.tfs\pat.txt` on Windows (or the path
   `TFS_PAT_FILE` points at — see below). The folder and file are created if they don't exist yet.
   On Linux, the extension also sets their permissions so only your account can read them
   (folder `700`, file `600`); on Windows the file simply inherits whatever permissions your user
   profile folder already has.
4. It confirms with "Personal access token saved."

Nothing writes this file automatically at startup or in the background, so if you edit `pat.txt`
by hand afterwards, it is never silently overwritten. The only other thing that writes it is a
recovery action: if a `tf` call fails with a missing or rejected token and VS Code still has a
token saved from an earlier **Set Personal Access Token** run, the error notification offers a
**Rewrite pat.txt from saved token** button. That copies the saved token back into the file — it
asks you to confirm first if the file already holds a different token — which is useful if
`pat.txt` itself got deleted, emptied, or accidentally saved with a BOM.

Both wrappers only ever look at the first line of the file: `tfp.cmd` reads it as-is, and `tfp`
on Linux also strips any surrounding whitespace, so a trailing newline either way is harmless.

**`TFS_PAT_FILE`** overrides the default path, for both sides at once: set it to a different file
and the **Set Personal Access Token** command writes there instead, and both wrappers read from
there instead — which is how you can keep more than one token (for example, one per Azure DevOps
organisation) by pointing different sessions at different files.

On Linux only, `tfp` also accepts the token directly through a `TFS_PAT` environment variable,
which wins over the file when both are set. The file is still the recommended way: an environment
variable is easy to leak into shell history or a child process's environment, and `tfp.cmd` on
Windows has no equivalent.

## Renew it

When the token is about to expire, create a new one the same way (**Full access**, a short
expiry) and either run **Team Explorer: Set Personal Access Token** again, or overwrite `pat.txt`
by hand. If `tf` rejects the current token, the extension shows:

> The personal access token was rejected. Run "Team Explorer: Set Personal Access Token".

## Security notes

A **Full access** token can do much more than a narrowly-scoped one, so treat it accordingly:

- Give it the shortest expiry that is practical, and renew it before it lapses.
- Keep the PAT file private. On Linux, the **Set Personal Access Token** command already restricts
  it to your account (permissions `600`); on Windows, it relies on your user profile folder not
  being shared with anyone else. If you create the file by hand, don't loosen either.
- While a `tf` command is running, the token is visible on its own command line (as part of
  `/login:.,<token>`) to anyone who can list processes on that machine — one more reason to keep
  the expiry short.
- Revoke the token from the same **Personal access tokens** page as soon as you no longer need it.
- Never paste the token into a chat, into an AI agent, or directly onto a command line. Always go
  through **Team Explorer: Set Personal Access Token** or the PAT file — the wrapper reads the
  token from that file, never from something you type as an argument.
