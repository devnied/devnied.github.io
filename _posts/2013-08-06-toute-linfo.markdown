---
layout: post
title:  "Site d'information sur l'actualité - Toute l'info.fr"
date:   2013-08-06
categories: projets
img: /images/toute-linfo/cover.jpg
copy: mjsonline
---

##Introduction
Toute l’info.fr est un agrégateur de flux rss.<br/>
Il permet de regrouper et de classer automatiquement par catégories ou domaines les news de différents sites.
 
<img src="/images/toute-linfo/logo.png" class="no-border"/>

Cet agrégateur est capable de parser des fils de syndication structurés mais aussi des fils ne suivant aucunes structures ou comportant des erreurs. Il permet de parser des flux XML normalisés comme les flux RSS ou Atom.
##Technologies
Ce site web est codé en JAVA EE, sans framework particulier, il utilise les composants par défaut de JEE (Jsp, servelet ...).<br/>
Afin de lire les flux XML, j’utilise un parseur basé sur SAX.<br/>
 
###Liste des formats de flux:
{% highlight text %}
Parses RSS 0.90
Netscape RSS 0.91
Userland RSS 0.91
RSS 0.92
RSS 0.93
RSS 0.94
RSS 1.0
RSS 2.0
Atom 0.3
Atom 1.0 feeds
{% endhighlight %}

 
Le portail web de toute-linfo.fr est en cours d’évolution.<br/>
Celui-ci est en cours de réécriture et utilisera JSF, JPA, les PrettyFaces ainsi que les EJB.



Lien vers le site: [Toute l'info.fr]<br/>
[Toute l'info.fr]: http://toute-linfo.fr "Site web toute-linfo.fr"