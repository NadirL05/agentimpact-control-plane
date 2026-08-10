# Dashboard — AgentImpact Control Plane

Dashboard statique qui consomme l'API du control plane.

## Usage

1. Démarrer l'API (depuis `src/`) :

```bash
npm run api
```

2. Ouvrir `dashboard/index.html` dans un navigateur, ou le servir avec un serveur statique :

```bash
# Avec Python
python -m http.server 8080 --directory dashboard

# Ou avec Node (si tu as serveur)
npx serve dashboard
```

3. Dans le dashboard :
   - URL de l'API : `http://localhost:3000` (par défaut)
   - Cliquer sur **🔄 Rafraî·¢chir**

## Fonctionnalité·¢s

- Affiche les profils Hermes, policies et workflows
- Bouton de rafraî·¢chissement
- Champ pour configurer l'URL de l'API

## Hébergement

Tu peux héberger ce dashboard sur :

- Vercel (dossier `dashboard` en tant que site statique)
- GitHub Pages
- Netlify

Il suffit de pointer vers le dossier `dashboard/` et de configurer l'URL de l'API.
