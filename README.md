# Veillée

Loups-Garous de Thiercelieux et Blood on the Clocktower entre amis, **chacun sur son téléphone**.
Un joueur crée la partie, les autres entrent le code à 5 lettres. Marche aussi sur PC (navigateur).

- **Maître du jeu optionnel** : sans MJ, l'appli mène la partie et tout le monde joue, hôte compris.
  Avec un MJ (n'importe quel joueur du salon), il voit le grimoire, valide ou corrige chaque
  information avant qu'elle parte, et peut tuer, ressusciter, empoisonner ou changer un rôle à la main.
- **Toutes les décisions sur son propre téléphone** : actions de nuit, votes, nominations, pouvoirs de jour.
- **Rôles** : BotC Trouble Brewing, Bad Moon Rising, Sects & Violets (72 personnages) ;
  Loups-Garous jeu de base, Nouvelle Lune, Personnages & Village (31 rôles).
- **Rôles sur mesure** : éditeur intégré (camp, pouvoir de nuit, ordre de réveil, particularités),
  partage par un code `VEIL1:…` à coller chez un ami.

## Comment ça marche

Pas de serveur à nous : les téléphones se parlent directement (WebRTC, bibliothèque PeerJS).
Le service public gratuit de PeerJS sert uniquement à mettre les appareils en relation.
**Le téléphone de l'hôte fait tourner la partie** : il doit rester allumé, l'appli sur l'écran
(elle empêche la mise en veille). S'il se ferme, « Reprendre ma partie » sur l'accueil la relance
et les autres se reconnectent tout seuls.

Il faut Internet (4G ou Wi-Fi) sur chaque appareil.

## La mettre en ligne (pour l'envoyer à ses potes)

C'est un site statique : n'importe quel hébergeur gratuit convient.

**GitHub Pages** : pousser ce dossier dans un dépôt GitHub, puis *Settings → Pages → Deploy from
branch → main / (root)*. L'adresse ressemble à `https://<pseudo>.github.io/Veillee/`.

**Netlify Drop** (sans compte Git) : glisser le dossier sur https://app.netlify.com/drop.

Ensuite on envoie le lien. Le bouton « Inviter des amis » du salon partage un lien qui contient
déjà le code de la partie.

### Installer sur le téléphone

- Android (Chrome) : bouton « Installer l'application » sur l'accueil, ou menu ⋮ → *Installer*.
- iPhone (Safari) : bouton Partager → *Sur l'écran d'accueil*.
- PC (Chrome / Edge) : icône d'installation dans la barre d'adresse.

## Tester en local

```bash
node tools/serve.mjs
```

Puis ouvrir http://localhost:5173. Pour simuler plusieurs joueurs dans un même navigateur,
ajouter `?profil=nom` à l'adresse : chaque profil a son propre pseudo et ses propres rôles.

```bash
node tools/sim.mjs 300
```

Joue 300 parties complètes avec des bots qui répondent au hasard (les deux jeux, toutes les
extensions, avec et sans MJ, composition auto et manuelle, rôles sur mesure). Sort en erreur si une
partie plante ou se bloque.

## Ce que le conteur automatique simplifie (sans MJ)

Là où un conteur humain choisirait, l'appli tire au hasard : fausses informations des joueurs ivres
ou empoisonnés, cible détournée du Maire, enregistrement du Reclus et de l'Espion, Pacifiste,
Bricoleur, régurgitation du Shabaloth. La « folie » (Cérénovus, Mutant) est annoncée au joueur mais
pas vérifiée. L'Artiste, le Savant et la Commère choisissent parmi des questions et déclarations
toutes faites. La Petite Fille espionne en un bouton (elle voit un loup, avec 30 % de risque d'être
repérée). Les cartes Événement de Nouvelle Lune et la Gitane ne sont pas incluses, ni les Voyageurs
et personnages expérimentaux de BotC — les rôles sur mesure servent à combler.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `js/engine.js` | joueurs, invites, messages, boucle nuit/jour, vue filtrée par joueur |
| `js/botc.js`, `js/lg.js` | règles, rôles et déroulé de chaque jeu |
| `js/roles/custom.js` | compilation des rôles sur mesure |
| `js/net.js` | connexions hôte / joueurs |
| `js/app.js` | interface |
| `sw.js`, `manifest.webmanifest` | installation et fonctionnement hors ligne de l'interface |
