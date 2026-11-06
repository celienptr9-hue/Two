# Two — messagerie avec Firebase Authentication

L’inscription, la connexion et la vérification des adresses e-mail sont gérées par Firebase Authentication. Firebase envoie un **lien de vérification** ; aucun serveur SMTP, code Brevo ou adresse d’expédition personnalisée n’est nécessaire. Les profils, invitations et conversations restent stockés dans SQLite et les messages sont actualisés en direct par SSE.

## Prérequis

- Node.js 20 ou plus récent et npm.
- Un projet Firebase avec **Authentication → E-mail/Mot de passe** activé.
- Une application Web Firebase et un compte de service Firebase Admin pour le serveur.

## Configurer Firebase

1. Dans la [console Firebase](https://console.firebase.google.com/), créez un projet ou sélectionnez-en un.
2. Dans **Authentication → Sign-in method**, activez **Email/Password**.
3. Dans **Authentication → Settings → Authorized domains**, vérifiez que `localhost` est autorisé pour le développement local.
4. Dans **Project settings → General → Your apps**, créez une application Web et relevez son `apiKey`, `authDomain`, `projectId` et `appId`. Renseignez ces valeurs dans le fichier local `.env`, créé à partir de `.env.example`.
5. Dans **Project settings → Service accounts**, générez une clé privée pour Firebase Admin. Placez le JSON téléchargé dans `secrets/firebase-service-account.json` et conservez `GOOGLE_APPLICATION_CREDENTIALS=./secrets/firebase-service-account.json` dans `.env`.
6. Dans **Authentication → Templates**, personnalisez si besoin le modèle de vérification d’adresse. Firebase enverra automatiquement le lien après l’inscription.

Les clés de configuration de l’application Web Firebase sont destinées au client. **Le JSON du compte de service contient un secret privé** : ne le partagez pas, ne le collez pas dans le chat et ne le commitez jamais. `.env`, `secrets/`, la base locale et le bundle de build sont exclus de Git.

## Démarrer

Dans le dossier du projet :

```powershell
npm install
npm start
```

Le script construit le bundle Firebase du navigateur, puis démarre l’application sur <http://localhost:3000>. `npm test` construit aussi le bundle et exécute les tests d’intégration de l’API ; Firebase Auth est simulé dans ces tests, sans compte ou courriel réel.

La base SQLite est créée dans `data/messaging.sqlite`. `DATABASE_PATH` permet de choisir un autre emplacement. Au premier accès après avoir cliqué sur le lien de vérification Firebase, le profil est créé avec le prénom, le nom et l’identifiant choisis.

## Migration et sécurité

Firebase Auth vérifie l’adresse e-mail par lien, et non par code à six chiffres. À la première connexion Firebase avec la même adresse vérifiée, le serveur associe le nouvel UID Firebase au profil SQLite existant. Les empreintes de mots de passe et les anciennes sessions locales sont supprimées lors de la migration de la base ; les utilisateurs devront créer/réinitialiser leur connexion via Firebase.

Le serveur valide chaque jeton d’identification Firebase avec Firebase Admin et refuse les comptes dont `email_verified` n’est pas vrai. En production, placez l’application derrière HTTPS et protégez le fichier de compte de service. Les profils, invitations et messages sont toujours conservés dans SQLite sur le serveur ; le contenu des conversations n’est pas chiffré de bout en bout.
